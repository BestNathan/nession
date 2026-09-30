//! Reading one Claude Code JSONL record into canonical facts (#1234).
//!
//! This is the only place in the crate that knows a Claude field name. Every
//! projection above it sees [`Entry`] and nothing else, which is what keeps the
//! conversation and the transcript from disagreeing about the same file.
//!
//! ## Three outcomes, and the difference between them is the point
//!
//! A record can be understood and carry something to draw
//! ([`Outcome::Recognized`]), understood and carry session state rather than an
//! event ([`Outcome::MetadataAbsorbed`]), or not modelled at all
//! ([`Outcome::Unknown`]). A record that is not JSON is [`Outcome::Invalid`].
//!
//! Measured over 170 real transcripts / 387,851 records, only the last two are
//! rare — and until they were separated, every record of the first two kinds was
//! reported to the reader as one the parser had failed to read. The median real
//! page carries 25 such records out of 50.
//!
//! ## Upstream names are data
//!
//! Claude's record types are an open set: the corpus carries 18 top-level types
//! and 7 `system` subtypes, and the set has changed between versions. So an entry
//! carries the upstream name as a **string** and a coarse [`EventCategory`],
//! rather than the crate enumerating subtypes Claude may rename. A new `system`
//! subtype is a new string here, not a new wire generation.

use serde_json::Value;

use crate::canonical::{
    entry_id, Attachment, Entry, EventCategory, Message, MessageBlock, MessageSource,
    MetadataEvent, Payload, Reasoning, RuntimeEvent, UnknownEvent,
};
use crate::conversation::string_field;

/// How a record was understood.
///
/// Exactly one arm per record, and the four arms partition the input — which is
/// what lets [`crate::canonical::ParseStats`] add up to the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Understood, and it carries at least one fact. May still carry no entry:
    /// a `tool_result` is understood and belongs to its call rather than beside
    /// it.
    Recognized,
    /// Understood as session state — a title, a mode, a PR link — which the
    /// conversation folds into its header rather than reading as an event.
    MetadataAbsorbed,
    /// Parsed, but this version has no model for the record's type. Carried as
    /// an [`Entry::Unknown`] so completeness is still reachable, and counted so
    /// the omission is visible.
    Unknown,
    /// Not a JSON object, so there is nothing to model.
    Invalid,
}

/// One record's contribution, before tool calls are paired with their results.
///
/// Pairing cannot happen here: a call and its result are different records, and
/// pages are read backwards from the end of an append-only file, so the two
/// halves routinely land on different pages. [`super::read`] does that pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fact {
    Entry(Entry),
    /// A `tool_use` block, awaiting the result that answers it.
    Call(PendingCall),
    /// A `tool_result` block, awaiting the call it answers.
    Result(PendingResult),
}

/// A tool call before its result is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingCall {
    pub id: String,
    pub call_id: String,
    pub name: String,
    pub timestamp: Option<String>,
    pub summary: String,
    pub input: Option<Payload>,
}

/// A tool result before its call is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingResult {
    pub call_id: String,
    pub is_error: bool,
    pub body: String,
}

/// What one record produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Adapted {
    pub facts: Vec<Fact>,
    pub outcome: Outcome,
}

/// Read one record. `offset` is the record's first byte, and is what gives a
/// record without a uuid an identity.
pub(crate) fn adapt(line: &str, offset: u64) -> Adapted {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return invalid();
    };
    if !record.is_object() {
        return invalid();
    }

    let id = record_id(&record, offset);
    let timestamp = string_field(&record, "timestamp");
    let Some(kind) = string_field(&record, "type") else {
        // It parsed, so it is a record; what this version cannot do is say what
        // it is. That is `Unknown`, and not `Invalid` — which has to keep
        // meaning "this could not be read at all".
        return unknown(UnknownEvent {
            id,
            upstream_type: None,
            upstream_subtype: string_field(&record, "subtype"),
            timestamp,
        });
    };

    match kind.as_str() {
        "user" | "assistant" => message(&record, &kind, id, timestamp),
        "attachment" => {
            let attachment_type = record
                .pointer("/attachment/type")
                .and_then(Value::as_str)
                .unwrap_or("attachment")
                .to_string();
            entry(Entry::Attachment(Attachment {
                id,
                timestamp,
                attachment_type,
                payload: record.get("attachment").map(json_payload),
            }))
        }
        // The `type` alone says nothing here — every one of these is `system` —
        // so the subtype is the name.
        "system" => runtime(
            id,
            timestamp,
            EventCategory::System,
            string_field(&record, "subtype").unwrap_or(kind),
        ),
        "file-history-snapshot" | "file-history-delta" => {
            runtime(id, timestamp, EventCategory::Checkpoint, kind)
        }
        "relocated" | "continued-in" => runtime(id, timestamp, EventCategory::Lifecycle, kind),
        "queue-operation" => runtime(id, timestamp, EventCategory::Runtime, kind),
        other if SESSION_STATE_TYPES.contains(&other) => Adapted {
            facts: vec![Fact::Entry(Entry::Metadata(MetadataEvent {
                id,
                timestamp,
                name: kind,
            }))],
            outcome: Outcome::MetadataAbsorbed,
        },
        _ => unknown(UnknownEvent {
            id,
            upstream_type: Some(kind),
            upstream_subtype: string_field(&record, "subtype"),
            timestamp,
        }),
    }
}

/// Records that state something about the session rather than reporting an
/// event in it.
///
/// Measured, these are the largest family by record count — and every one of
/// them was reported to the reader as a record the parser had failed to read,
/// because "this is session state" and "this could not be read" were the same
/// bucket.
///
/// The list is closed on purpose. A type Claude adds later falls to
/// [`Outcome::Unknown`], which is visible in the counts — that drift being
/// observable is the point, where absorbing anything unfamiliar would hide it.
const SESSION_STATE_TYPES: [&str; 9] = [
    "ai-title",
    "last-prompt",
    "mode",
    "permission-mode",
    "pr-link",
    "agent-name",
    "atis-latch",
    "cost-state",
    "worktree-state",
];

fn invalid() -> Adapted {
    Adapted {
        facts: Vec::new(),
        outcome: Outcome::Invalid,
    }
}

fn entry(entry: Entry) -> Adapted {
    Adapted {
        facts: vec![Fact::Entry(entry)],
        outcome: Outcome::Recognized,
    }
}

fn runtime(
    id: String,
    timestamp: Option<String>,
    category: EventCategory,
    name: String,
) -> Adapted {
    entry(Entry::Runtime(RuntimeEvent {
        id,
        timestamp,
        category,
        name,
    }))
}

fn unknown(event: UnknownEvent) -> Adapted {
    Adapted {
        facts: vec![Fact::Entry(Entry::Unknown(event))],
        outcome: Outcome::Unknown,
    }
}

/// The record's identity: its uuid, or its position when it has none.
///
/// 129,829 measured records carry no uuid — every session-state and checkpoint
/// record among them. Falling back to the empty string would make them all one
/// entry to a client keying identity reuse on it; the byte offset is a property
/// of the transcript and stable across polls.
fn record_id(record: &Value, offset: u64) -> String {
    string_field(record, "uuid").unwrap_or_else(|| format!("offset:{offset}"))
}

/// One message record's facts.
fn message(record: &Value, kind: &str, id: String, timestamp: Option<String>) -> Adapted {
    let Some(body) = record.get("message") else {
        // The envelope says it is a turn but carries no body to read. Not
        // modelled, and said so, rather than silently rendered as an empty turn.
        return unknown(UnknownEvent {
            id,
            upstream_type: Some(kind.to_string()),
            upstream_subtype: string_field(record, "subtype"),
            timestamp,
        });
    };

    let source = message_source(record, kind);
    let sidechain = record.get("isSidechain").and_then(Value::as_bool) == Some(true);
    let mut facts: Vec<Fact> = Vec::new();

    match body.get("content") {
        Some(Value::String(text)) => {
            if !text.trim().is_empty() {
                facts.push(prose(
                    &id,
                    source,
                    &timestamp,
                    sidechain,
                    0,
                    &[MessageBlock::Text { text: text.clone() }],
                ));
            }
        }
        Some(Value::Array(blocks)) => {
            blocks_of(&mut facts, blocks, &id, source, &timestamp, sidechain);
        }
        _ => {
            return unknown(UnknownEvent {
                id,
                upstream_type: Some(kind.to_string()),
                upstream_subtype: string_field(record, "subtype"),
                timestamp,
            })
        }
    }

    Adapted {
        facts,
        outcome: Outcome::Recognized,
    }
}

/// Walk one record's content blocks, emitting facts in transcript order.
fn blocks_of(
    facts: &mut Vec<Fact>,
    blocks: &[Value],
    id: &str,
    source: MessageSource,
    timestamp: &Option<String>,
    sidechain: bool,
) {
    // Consecutive prose merges into one message, so a turn that wrote two
    // paragraphs is one bubble rather than two. A tool call or a reasoning block
    // ends the run: they are *between* the prose on either side of them, which
    // is the order the blocks are in and the order a reader expects.
    let mut prose_blocks: Vec<MessageBlock> = Vec::new();
    let mut run_start: Option<usize> = None;

    for (index, block) in blocks.iter().enumerate() {
        match string_field(block, "type").as_deref() {
            Some("text") => {
                let Some(text) = string_field(block, "text") else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                run_start.get_or_insert(index);
                prose_blocks.push(MessageBlock::Text { text });
            }
            Some(kind @ ("thinking" | "redacted_thinking")) => {
                flush(
                    facts,
                    &mut prose_blocks,
                    &mut run_start,
                    id,
                    source,
                    timestamp,
                    sidechain,
                );
                facts.push(Fact::Entry(Entry::Reasoning(Reasoning {
                    id: entry_id(id, index),
                    timestamp: timestamp.clone(),
                    reasoning_type: kind.to_string(),
                    text: reasoning_text(block),
                })));
            }
            Some("tool_use") => {
                flush(
                    facts,
                    &mut prose_blocks,
                    &mut run_start,
                    id,
                    source,
                    timestamp,
                    sidechain,
                );
                let name = string_field(block, "name").unwrap_or_else(|| "tool".to_string());
                let input = block.get("input");
                facts.push(Fact::Call(PendingCall {
                    id: entry_id(id, index),
                    call_id: string_field(block, "id").unwrap_or_default(),
                    summary: tool_summary(&name, input),
                    name,
                    timestamp: timestamp.clone(),
                    input: input.map(json_payload),
                }));
            }
            // A result is not an entry: it is what its call produced. Kept as a
            // fact so the pairing pass can find it, and never drawn beside the
            // call it answers.
            Some("tool_result") => facts.push(Fact::Result(PendingResult {
                call_id: string_field(block, "tool_use_id").unwrap_or_default(),
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                body: result_body(block.get("content")),
            })),
            // Anything else is a block type this version does not model. The
            // position is kept rather than the content, so a message that
            // carried one does not read as if it had not.
            _ => {
                run_start.get_or_insert(index);
                prose_blocks.push(MessageBlock::Unknown);
            }
        }
    }

    flush(
        facts,
        &mut prose_blocks,
        &mut run_start,
        id,
        source,
        timestamp,
        sidechain,
    );
}

/// Emit the prose run collected so far, if there is one.
fn flush(
    facts: &mut Vec<Fact>,
    prose: &mut Vec<MessageBlock>,
    run_start: &mut Option<usize>,
    id: &str,
    source: MessageSource,
    timestamp: &Option<String>,
    sidechain: bool,
) {
    if prose.is_empty() {
        return;
    }
    let start = run_start.take().unwrap_or(0);
    facts.push(prose_fact(
        id,
        source,
        timestamp,
        sidechain,
        start,
        std::mem::take(prose),
    ));
}

fn prose(
    id: &str,
    source: MessageSource,
    timestamp: &Option<String>,
    sidechain: bool,
    start: usize,
    content: &[MessageBlock],
) -> Fact {
    prose_fact(id, source, timestamp, sidechain, start, content.to_vec())
}

fn prose_fact(
    id: &str,
    source: MessageSource,
    timestamp: &Option<String>,
    sidechain: bool,
    start: usize,
    content: Vec<MessageBlock>,
) -> Fact {
    Fact::Entry(Entry::Message(Message {
        id: entry_id(id, start),
        source,
        timestamp: timestamp.clone(),
        content,
        sidechain,
    }))
}

/// What a reasoning block's text is, across the two shapes measured.
fn reasoning_text(block: &Value) -> String {
    // `thinking` carries its text there; a redacted block carries an opaque
    // `data` blob instead, and showing it verbatim is the honest reading of "the
    // model reasoned here and the reasoning was withheld".
    string_field(block, "thinking")
        .or_else(|| string_field(block, "data"))
        .unwrap_or_default()
}

/// A tool input as a payload.
fn json_payload(input: &Value) -> Payload {
    Payload {
        text: serde_json::to_string_pretty(input).unwrap_or_default(),
        is_json: true,
        truncated: false,
    }
}

/// A bounded, single-line description of a tool call.
///
/// Specialized by name where a tool has an argument that *is* the call — a
/// `Read` is its path, a `Bash` is its command — and generic otherwise, so a tool
/// Claude adds next month reads as its own best argument rather than as nothing.
/// The specialization lives here rather than in a contract because Claude's tool
/// set is open: a client that knew these names would be a client that breaks when
/// the set changes.
fn tool_summary(name: &str, input: Option<&Value>) -> String {
    let described = input
        .and_then(|input| specialized(name, input))
        .unwrap_or_else(|| generic(input));
    collapse_whitespace(&described)
}

/// The argument that best stands for the call, for the tools that have one.
fn specialized(name: &str, input: &Value) -> Option<String> {
    // Every arm reads a different key, and a missing key falls through to the
    // generic description rather than producing an empty summary.
    let key = match name {
        "Read" | "Edit" | "Write" | "NotebookEdit" => ["file_path", "notebook_path"].as_slice(),
        "Bash" => ["command", "description"].as_slice(),
        "Glob" | "Grep" => ["pattern"].as_slice(),
        "WebFetch" | "WebSearch" => ["url", "query"].as_slice(),
        "Task" | "Agent" => ["description", "prompt"].as_slice(),
        _ => return None,
    };
    key.iter()
        .find_map(|key| input.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

/// What to say about a tool this version does not know by name.
fn generic(input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    match input {
        Value::Object(map) => {
            // The keys, not the values: a value could be a whole file, and the
            // summary is a line in a collapsed row.
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.sort_unstable();
            keys.join(", ")
        }
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Collapse runs of whitespace to single spaces.
///
/// A `Bash` command is routinely several lines, and the summary is one line in a
/// collapsed row — a summary that carried newlines would either wrap the row or
/// be clipped by CSS, and neither says what the command was.
fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<&str>>().join(" ")
}

/// The text of a `tool_result`'s `content`.
///
/// Two shapes occur, as in a message's own content: a plain string, or a list of
/// blocks each carrying `text`. Both are flattened to text. A result that is
/// neither yields nothing rather than a serialized blob — the summary line still
/// says the call happened, and inventing a rendering of an unmodelled shape is
/// how a transcript starts showing things that were not said.
fn result_body(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| string_field(block, "text"))
            .collect::<Vec<String>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Where a message record came from.
///
/// `kind` decides the assistant side outright — the envelope and the body agree
/// there. The user side does not, so it is read from Claude Code's own
/// provenance fields rather than from the text: nothing in the text separates a
/// turn a human typed from injected context, and 509 measured text-bearing user
/// records carry no provenance field at all — a class that is *not* one thing
/// (185 slash-command expansions a human typed, 181 interruption markers, 59
/// local-command output, 81 ordinary prose). A classifier reading the text would
/// hide the first along with the third, and losing a message the user wrote is a
/// worse failure than showing a line of bookkeeping.
///
/// For the 243 records with no provenance field that begin with runtime wrappers
/// (`[Request interrupted`, `<local-command-stdout>`, `<bash-input>`, `<bash-stdout>`),
/// the content is matched by text prefix as a last resort. This is deliberate:
/// a user message that happens to begin with these wrappers would be misclassified,
/// but the measured corpus shows these wrappers are exclusive to runtime output.
pub(crate) fn message_source(record: &Value, kind: &str) -> MessageSource {
    if kind == "assistant" {
        return MessageSource::Assistant;
    }
    // Injected context, by Claude Code's own marker.
    if record.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return MessageSource::Synthetic;
    }
    if is_system_turn(record) {
        return MessageSource::System;
    }
    // Last resort: check if the content begins with a runtime wrapper.
    // This handles the 243 records with no provenance field that are still
    // runtime output rather than human turns.
    if let Some(content_text) = extract_message_text(record) {
        if is_runtime_content(&content_text) {
            return MessageSource::System;
        }
    }
    MessageSource::Human
}

/// Extract the text content from a message record for prefix matching.
///
/// Returns the concatenated text from either a string-bodied message or the
/// text blocks of an array-bodied message. Returns `None` if the message has
/// no text content or the content shape is not understood.
fn extract_message_text(record: &Value) -> Option<String> {
    let body = record.get("message")?;
    let content = body.get("content")?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let texts: Vec<String> = blocks
                .iter()
                .filter_map(|block| {
                    if string_field(block, "type").as_deref() == Some("text") {
                        string_field(block, "text")
                    } else {
                        None
                    }
                })
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join(""))
            }
        }
        _ => None,
    }
}

/// Whether the runtime, rather than a human, produced this turn.
///
/// Four declared markers, measured over 170 real transcripts / 58,350
/// `type=user` records, and together they cover every non-human turn in the
/// corpus: `promptSource: "system"` (1,583), `origin.kind: "task-notification"`
/// (1,499), and `turnOrigin` in {task_notification, scheduled} (859). The peer
/// case is the odd one out — another Nession session spoke, which is neither
/// this human nor this runtime — and is kept with the system turns because it is
/// equally not the user's own voice.
///
/// A further 243 records carry no provenance field at all but begin with
/// runtime wrappers: `[Request interrupted` (181), `<local-command-stdout>`
/// (59), `<bash-input>` (2), `<bash-stdout>` (1). These are matched by text
/// prefix as a last resort, with explicit tests per wrapper.
fn is_system_turn(record: &Value) -> bool {
    if string_field(record, "promptSource").as_deref() == Some("system") {
        return true;
    }
    if record
        .get("origin")
        .and_then(|origin| string_field(origin, "kind"))
        .as_deref()
        == Some("task-notification")
    {
        return true;
    }
    matches!(
        string_field(record, "turnOrigin").as_deref(),
        Some("task_notification" | "scheduled" | "peer")
    )
}

/// Whether the message content is a runtime marker or command output rather
/// than a human-authored turn.
///
/// 243 measured `type=user` records carry no provenance field but begin with
/// a runtime wrapper. These are not human turns, and classifying them as such
/// would show them as "You: [Request interrupted...]" or "You: <local-command-stdout>...",
/// which is misleading. The wrappers are literal and appear at the start of
/// `message.content`.
fn is_runtime_content(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("[Request interrupted")
        || trimmed.starts_with("<local-command-stdout>")
        || trimmed.starts_with("<bash-input>")
        || trimmed.starts_with("<bash-stdout>")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The entries one record produces, ignoring the pairing facts.
    fn entries_of(line: &str) -> Vec<Entry> {
        adapt(line, 0)
            .facts
            .into_iter()
            .filter_map(|fact| match fact {
                Fact::Entry(entry) => Some(entry),
                Fact::Call(_) | Fact::Result(_) => None,
            })
            .collect()
    }

    fn outcome_of(line: &str) -> Outcome {
        adapt(line, 0).outcome
    }

    fn user(content: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"u1","timestamp":"2026-09-25T00:00:00Z","message":{{"role":"user","content":{content}}}}}"#
        )
    }

    fn assistant(content: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"a1","timestamp":"2026-09-25T00:00:01Z","message":{{"role":"assistant","content":{content}}}}}"#
        )
    }

    // ---- messages -------------------------------------------------------

    #[test]
    fn a_human_record_becomes_a_human_message() {
        let entries = entries_of(&user(r#"[{"type":"text","text":"hello"}]"#));

        assert_eq!(
            entries,
            vec![Entry::Message(Message {
                id: "u1".into(),
                source: MessageSource::Human,
                timestamp: Some("2026-09-25T00:00:00Z".into()),
                content: vec![MessageBlock::Text {
                    text: "hello".into()
                }],
                sidechain: false,
            })]
        );
    }

    #[test]
    fn an_assistant_record_becomes_an_assistant_message() {
        let entries = entries_of(&assistant(r#"[{"type":"text","text":"hi"}]"#));
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(message.source, MessageSource::Assistant);
    }

    #[test]
    fn a_meta_record_becomes_synthetic_rather_than_human() {
        // Measured: 700 `type=user` records carry `isMeta: true` with text
        // content. The canonical model can say what they are, which the
        // conversation projection needs in order to hide them.
        let line = r#"{"type":"user","uuid":"m1","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"injected context"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.source,
            MessageSource::Synthetic,
            "injected context was modelled as a turn a human wrote"
        );
    }

    #[test]
    fn a_notification_record_becomes_a_system_turn_rather_than_a_human_one() {
        // 1,499 measured records arrive this way: a background task finished.
        // `System` and not `Synthetic`: something in the session really did
        // speak, where `Synthetic` is material injected for the model to read.
        let line = r#"{"type":"user","uuid":"n1","promptSource":"system","origin":{"kind":"task-notification"},"message":{"role":"user","content":[{"type":"text","text":"<task-notification>done</task-notification>"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(message.source, MessageSource::System);
    }

    #[test]
    fn a_scheduled_turn_is_a_system_turn() {
        // 132 measured records fired from a schedule, and 51 from a peer
        // session. Neither is this human's voice, and neither is injected
        // context.
        for record in [
            r#"{"type":"user","uuid":"s1","turnOrigin":"scheduled","message":{"role":"user","content":[{"type":"text","text":"cron fired"}]}}"#,
            r#"{"type":"user","uuid":"p1","turnOrigin":"peer","message":{"role":"user","content":[{"type":"text","text":"another session"}]}}"#,
        ] {
            let entries = entries_of(record);
            let [Entry::Message(message)] = entries.as_slice() else {
                panic!("expected one message, got {entries:?}");
            };
            assert_eq!(message.source, MessageSource::System, "{record}");
        }
    }

    #[test]
    fn a_request_interrupted_marker_is_a_system_turn() {
        // 181 measured records carry no provenance field but begin with
        // `[Request interrupted`. These are runtime markers, not human turns.
        let line = r#"{"type":"user","uuid":"i1","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.source,
            MessageSource::System,
            "interruption marker was modelled as a human turn"
        );
    }

    #[test]
    fn local_command_output_is_a_system_turn() {
        // 59 measured records carry no provenance field but begin with
        // `<local-command-stdout>`. These are command outputs, not human turns.
        let line = r#"{"type":"user","uuid":"c1","message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>\noutput here\n</local-command-stdout>"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.source,
            MessageSource::System,
            "command output was modelled as a human turn"
        );
    }

    #[test]
    fn bash_input_is_a_system_turn() {
        // 2 measured records carry no provenance field but begin with
        // `<bash-input>`. These are command inputs, not human turns.
        let line = r#"{"type":"user","uuid":"b1","message":{"role":"user","content":[{"type":"text","text":"<bash-input>ls -la</bash-input>"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.source,
            MessageSource::System,
            "bash input was modelled as a human turn"
        );
    }

    #[test]
    fn bash_output_is_a_system_turn() {
        // 1 measured record carries no provenance field but begins with
        // `<bash-stdout>`. This is command output, not a human turn.
        let line = r#"{"type":"user","uuid":"b2","message":{"role":"user","content":[{"type":"text","text":"<bash-stdout>file1\nfile2</bash-stdout>"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.source,
            MessageSource::System,
            "bash output was modelled as a human turn"
        );
    }

    #[test]
    fn a_command_name_prefix_stays_human() {
        // 185 measured records begin with `<command-name>` and are slash
        // commands the user typed. These ARE human turns, not runtime output.
        let line = r#"{"type":"user","uuid":"cmd1","message":{"role":"user","content":[{"type":"text","text":"<command-name>/help</command-name>"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.source,
            MessageSource::Human,
            "slash command was misclassified as system output"
        );
    }

    #[test]
    fn prose_around_a_tool_call_stays_on_the_sides_it_was_written() {
        // Order is the transcript's, not an arrangement: the reader needs to see
        // that the model said something, called a tool, then said more.
        let line = assistant(
            r#"[{"type":"text","text":"before"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}},{"type":"text","text":"after"}]"#,
        );
        let adapted = adapt(&line, 0);

        let shape: Vec<&str> = adapted
            .facts
            .iter()
            .map(|fact| match fact {
                Fact::Entry(Entry::Message(_)) => "message",
                Fact::Call(_) => "call",
                Fact::Entry(other) => panic!("unexpected entry {other:?}"),
                Fact::Result(_) => "result",
            })
            .collect();
        assert_eq!(shape, vec!["message", "call", "message"]);
    }

    #[test]
    fn a_second_run_of_prose_in_one_record_gets_its_own_id() {
        // Two runs are two entries, and two entries need two ids — otherwise a
        // client keying identity reuse across polls sees one item where there
        // were two.
        let line = assistant(
            r#"[{"type":"text","text":"before"},{"type":"tool_use","id":"t1","name":"Bash","input":{}},{"type":"text","text":"after"}]"#,
        );
        let ids: Vec<String> = entries_of(&line)
            .iter()
            .map(|e| e.id().to_string())
            .collect();
        assert_eq!(ids, vec!["a1", "a1#2"]);
    }

    #[test]
    fn an_unmodelled_block_keeps_its_position_rather_than_vanishing() {
        let line = assistant(r#"[{"type":"text","text":"seen"},{"type":"brand_new_kind","x":1}]"#);
        let entries = entries_of(&line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.content,
            vec![
                MessageBlock::Text {
                    text: "seen".into()
                },
                MessageBlock::Unknown
            ]
        );
    }

    #[test]
    fn a_turn_of_nothing_but_unmodelled_blocks_is_still_a_turn() {
        // A hole the reader cannot see is worse than a line saying something was
        // there. The record *is* a turn — it is the blocks inside it that this
        // version cannot read — so it stays a message whose single block is
        // unknown, rather than becoming a record that failed to parse.
        let line = assistant(r#"[{"type":"brand_new_kind","x":1}]"#);
        let entries = entries_of(&line);

        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(message.content, vec![MessageBlock::Unknown]);
        assert_eq!(outcome_of(&line), Outcome::Recognized);
    }

    #[test]
    fn a_string_bodied_message_is_read_like_a_block_bodied_one() {
        // Both shapes occur in real transcripts — one measured sample had 62
        // string-bodied user turns — so accepting only the list form would drop
        // real messages while looking like it worked.
        let entries = entries_of(&user(r#""plain text""#));
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert_eq!(
            message.content,
            vec![MessageBlock::Text {
                text: "plain text".into()
            }]
        );
    }

    #[test]
    fn a_sidechain_record_is_marked_rather_than_mistaken_for_the_conversation() {
        // A subagent's turn is a real fact about the session and not part of the
        // main conversation.
        //
        // An earlier version of this comment said no record in the local corpus
        // carried the marker. That was wrong, and the way it was wrong is worth
        // keeping: the measurement globbed `projects/*/*.jsonl`, which never
        // descends into `projects/<dir>/<session>/subagents/`. Measured across
        // the whole tree, **all 91,137** records in the 464 subagent transcripts
        // carry `isSidechain: true` — the marker is not rare, the *files* were
        // invisible to a discovery that only lists the project level.
        let line = r#"{"type":"assistant","uuid":"s1","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}"#;
        let entries = entries_of(line);
        let [Entry::Message(message)] = entries.as_slice() else {
            panic!("expected one message, got {entries:?}");
        };
        assert!(message.sidechain);
    }

    // ---- reasoning ------------------------------------------------------

    #[test]
    fn a_thinking_block_is_parsed_as_reasoning() {
        // The largest block type in a real transcript — 49,795 `thinking` blocks
        // against 22,739 `text`. The conversation hides it; hiding it must not
        // mean failing to read it.
        let line = assistant(
            r#"[{"type":"thinking","thinking":"weighing options"},{"type":"text","text":"answer"}]"#,
        );
        let entries = entries_of(&line);

        let [Entry::Reasoning(reasoning), Entry::Message(_)] = entries.as_slice() else {
            panic!("expected reasoning then a message, got {entries:?}");
        };
        assert_eq!(reasoning.reasoning_type, "thinking");
        assert_eq!(reasoning.text, "weighing options");
    }

    #[test]
    fn a_redacted_thinking_block_is_reasoning_too() {
        // The same family under another name, and the reason `reasoning_type` is
        // a string: a new member of it must not need a new model.
        let line = assistant(r#"[{"type":"redacted_thinking","data":"opaque"}]"#);
        let entries = entries_of(&line);

        let [Entry::Reasoning(reasoning)] = entries.as_slice() else {
            panic!("expected reasoning, got {entries:?}");
        };
        assert_eq!(reasoning.reasoning_type, "redacted_thinking");
    }

    // ---- attachments, runtime, metadata ---------------------------------

    #[test]
    fn an_attachment_record_carries_its_upstream_type() {
        // `attachment` is the second-largest type in the corpus (69,824
        // records), and the type inside it is one of ~30. A string, so a new one
        // is data rather than a new model.
        let line = r#"{"type":"attachment","uuid":"att1","timestamp":"2026-09-25T00:00:02Z","attachment":{"type":"hook_success"}}"#;
        let entries = entries_of(line);

        let [Entry::Attachment(attachment)] = entries.as_slice() else {
            panic!("expected an attachment, got {entries:?}");
        };
        assert_eq!(attachment.attachment_type, "hook_success");
        assert_eq!(outcome_of(line), Outcome::Recognized);
    }

    #[test]
    fn a_system_record_is_a_runtime_event_named_by_its_subtype() {
        let line = r#"{"type":"system","uuid":"sys1","subtype":"turn_duration","durationMs":4200}"#;
        let entries = entries_of(line);

        let [Entry::Runtime(event)] = entries.as_slice() else {
            panic!("expected a runtime event, got {entries:?}");
        };
        assert_eq!(event.category, EventCategory::System);
        assert_eq!(event.name, "turn_duration");
    }

    #[test]
    fn a_file_history_record_is_a_checkpoint_not_an_unknown() {
        // 5,896 measured records, and none of them carries a uuid — which is why
        // an entry's identity cannot come from the uuid alone.
        let line = r#"{"type":"file-history-snapshot","messageId":"m1","snapshot":{}}"#;
        let entries = entries_of(line);

        let [Entry::Runtime(event)] = entries.as_slice() else {
            panic!("expected a runtime event, got {entries:?}");
        };
        assert_eq!(event.category, EventCategory::Checkpoint);
        assert_eq!(event.name, "file-history-snapshot");
    }

    #[test]
    fn a_queue_operation_is_a_runtime_event() {
        let line = r#"{"type":"queue-operation","operation":"enqueue"}"#;
        let entries = entries_of(line);
        let [Entry::Runtime(event)] = entries.as_slice() else {
            panic!("expected a runtime event, got {entries:?}");
        };
        assert_eq!(event.category, EventCategory::Runtime);
    }

    #[test]
    fn session_state_records_are_metadata_not_unknowns() {
        // The largest family by record count. Each one changes something about
        // the session — its title, its mode, its PR — rather than saying
        // anything, and the conversation folds them into its header. Counting
        // them as records the reader could not read is what made a real page
        // report that half of itself was missing.
        for (line, name) in [
            (r#"{"type":"ai-title","aiTitle":"a title"}"#, "ai-title"),
            (
                r#"{"type":"last-prompt","lastPrompt":"do it"}"#,
                "last-prompt",
            ),
            (r#"{"type":"mode","mode":"plan"}"#, "mode"),
            (
                r#"{"type":"permission-mode","permissionMode":"plan"}"#,
                "permission-mode",
            ),
            (r#"{"type":"pr-link","prNumber":1,"prUrl":"u"}"#, "pr-link"),
            (
                r#"{"type":"agent-name","agentName":"explore"}"#,
                "agent-name",
            ),
            (r#"{"type":"atis-latch","atis":{}}"#, "atis-latch"),
            (r#"{"type":"cost-state","cost":1}"#, "cost-state"),
        ] {
            let entries = entries_of(line);
            let [Entry::Metadata(event)] = entries.as_slice() else {
                panic!("{name} did not become metadata: {entries:?}");
            };
            assert_eq!(event.name, name);
            assert_eq!(
                outcome_of(line),
                Outcome::MetadataAbsorbed,
                "{name} was not accounted as session state"
            );
        }
    }

    // ---- the open set, and identity -------------------------------------

    #[test]
    fn a_record_type_this_version_does_not_know_keeps_its_upstream_name() {
        // The compatibility requirement in one test: Claude adds a record type,
        // and the answer is data rather than a failure. It is `Unknown` — so a
        // completeness-oriented reader can still show it and a reading-oriented
        // one can count it — and neither needs a new wire generation.
        let line = r#"{"type":"quantum-entanglement-state","subtype":"collapsed","uuid":"q1","timestamp":"2026-09-25T00:00:03Z"}"#;
        let entries = entries_of(line);

        let [Entry::Unknown(unknown)] = entries.as_slice() else {
            panic!("expected an unknown entry, got {entries:?}");
        };
        assert_eq!(
            unknown.upstream_type.as_deref(),
            Some("quantum-entanglement-state")
        );
        assert_eq!(unknown.upstream_subtype.as_deref(), Some("collapsed"));
        assert_eq!(outcome_of(line), Outcome::Unknown);
    }

    #[test]
    fn a_record_with_no_uuid_gets_an_id_from_its_position() {
        // 129,829 measured records carry no uuid — every metadata and checkpoint
        // record among them. An empty id would make them all the same entry to a
        // client keying on identity, so the byte offset stands in: it is a
        // property of the transcript, and stable across polls.
        let adapted = adapt(r#"{"type":"ai-title","aiTitle":"x"}"#, 4096);
        let ids: Vec<String> = adapted
            .facts
            .iter()
            .map(|fact| match fact {
                Fact::Entry(entry) => entry.id().to_string(),
                Fact::Call(call) => call.id.clone(),
                Fact::Result(result) => result.call_id.clone(),
            })
            .collect();
        assert_eq!(ids, vec!["offset:4096"]);
    }

    #[test]
    fn a_record_with_a_uuid_keeps_it() {
        let adapted = adapt(r#"{"type":"ai-title","aiTitle":"x","uuid":"kept"}"#, 4096);
        let [Fact::Entry(entry)] = adapted.facts.as_slice() else {
            panic!("expected one entry");
        };
        assert_eq!(entry.id(), "kept");
    }

    #[test]
    fn a_line_that_is_not_json_is_invalid() {
        // Distinct from unknown: there is no record here to model, and no
        // upstream name to report. A transcript being appended to routinely ends
        // in one.
        for line in ["not json at all", "", "{", "[]"] {
            assert_eq!(outcome_of(line), Outcome::Invalid, "{line:?}");
        }
    }

    #[test]
    fn a_json_object_with_no_type_is_unknown_rather_than_invalid() {
        // It parsed, so it is a record; what this version cannot do is say what
        // it is. The distinction is what keeps `invalid` meaning "could not be
        // read at all".
        assert_eq!(outcome_of(r#"{"uuid":"x"}"#), Outcome::Unknown);
    }

    #[test]
    fn a_paired_tool_result_carries_no_entry_of_its_own() {
        // It belongs to its call, and a reader that rendered both would double
        // the tool noise. `Recognized` — the record was understood; it simply is
        // not a row.
        let line = user(r#"[{"type":"tool_result","tool_use_id":"t1","content":"output"}]"#);
        let adapted = adapt(&line, 0);

        assert_eq!(adapted.outcome, Outcome::Recognized);
        assert!(
            !adapted.facts.iter().any(|f| matches!(f, Fact::Entry(_))),
            "a tool result became an entry of its own: {:?}",
            adapted.facts
        );
        assert!(
            adapted.facts.iter().any(|f| matches!(f, Fact::Result(_))),
            "the result was dropped instead of kept for pairing"
        );
    }

    #[test]
    fn a_message_with_no_readable_content_is_understood_and_silent() {
        // An empty string, or a body of nothing. Understood — and not an entry,
        // because there is nothing to draw.
        for line in [user(r#""""#), user(r#"[]"#)] {
            assert_eq!(outcome_of(&line), Outcome::Recognized, "{line}");
            assert!(entries_of(&line).is_empty(), "{line}");
        }
    }
}
