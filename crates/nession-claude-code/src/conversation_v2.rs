//! Normalizing a transcript into `claude-code.conversation` v2 (#1167).
//!
//! Kept beside [`crate::conversation`] rather than inside it so the v1 path
//! stays independently readable: v1 is shipped and unchanged, and a reviewer
//! checking "did v1 move?" should not have to diff it against a rewrite.
//!
//! ## Tool pairing is the whole difference, and it spans pages
//!
//! v1 turned a `tool_use` block into a row and dropped `tool_result` entirely,
//! so no tool could report what it produced and `is_error` shipped hardcoded
//! `false`. v2 pairs `tool_use.id` with `tool_result.tool_use_id` and renders one
//! activity item per *call*.
//!
//! The pairing cannot live in a per-record function. Pages are read backwards
//! from the end of an append-only file, so a call can be the last record of one
//! page while its result is the first record of the next — a per-line normalizer
//! sees each half alone and can only ever call both halves orphans. So the page
//! is selected first (by [`crate::conversation::select_records`], shared with v1)
//! and then **scanned forward** past its own end for the results it is missing.
//!
//! The scan is bounded, and the bound is measured rather than guessed: over 1180
//! real tool calls the gap between a call and its result was min 1, p50 2, p90 7,
//! p99 12, max **17** records (max 51 KB). [`PAIR_SCAN_MAX_BYTES`] is an order of
//! magnitude over the p99, so in practice the scan resolves everything and stops
//! early on the "every call answered" condition rather than on the cap.
//!
//! When it *does* stop at the cap with calls outstanding, those calls report
//! [`ToolStatusV2::Unknown`] — not `Running`. "We did not look far enough" and
//! "it is still going" are different facts, and a provider that presents the
//! first as the second is making a claim it cannot support.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde_json::Value;

use crate::conversation::{select_records, string_field, Discovered};
use crate::protocol::conversation::v2::{
    ConversationContentV2, ConversationItemV2, PayloadKindV2, PayloadV2, RoleV2, ToolStatusV2,
    ToolV2, PAGE_PAYLOAD_BUDGET, TOOL_INPUT_CEILING, TOOL_OUTPUT_CEILING, TOOL_SUMMARY_CEILING,
};

/// How far past a page's end the pairing scan will look.
///
/// See the module docs: measured p99 is 12 records / 21 KB, so 64 records and
/// 256 KiB leave room for an order-of-magnitude outlier before a call is
/// reported as unknown rather than answered.
const PAIR_SCAN_MAX_RECORDS: usize = 64;
const PAIR_SCAN_MAX_BYTES: u64 = 256 * 1024;

/// How much to read at a time while scanning forward.
const READ_CHUNK: u64 = 32 * 1024;

/// One page of a v2 conversation.
#[derive(Debug, Clone, Default)]
pub struct PageV2 {
    pub items: Vec<ConversationItemV2>,
    /// Byte offset to pass back to read the page before this one.
    pub next_offset: Option<u64>,
    pub has_more: bool,
    /// The file ended mid-record. Normal for a transcript being appended to.
    pub partial_tail: bool,
    /// Records this module did not model.
    pub skipped: u64,
}

/// What a `tool_result` record said, before it is attached to its call.
#[derive(Debug, Clone)]
struct ResultFact {
    is_error: bool,
    body: String,
}

/// A tool call waiting for its result.
#[derive(Debug, Clone)]
struct PendingCall {
    /// The item's id.
    id: String,
    timestamp: Option<String>,
    call_id: String,
    name: String,
    summary: String,
    /// Already cut to the per-body ceiling; the page budget is applied later,
    /// because it is a property of the page and not of the call.
    input: Option<PayloadV2>,
}

/// Something a page is made of, in document order.
#[derive(Debug)]
enum Slot {
    Item(ConversationItemV2),
    Call(PendingCall),
}

/// A page of `claude-code.conversation` v2.
pub fn read_page(
    conversation: &Discovered,
    end_offset: Option<u64>,
    limit: usize,
) -> std::io::Result<PageV2> {
    let mut file = File::open(conversation.path())?;
    let file_len = file.metadata()?.len();
    let end = end_offset.unwrap_or(file_len).min(file_len);
    let selected = select_records(&mut file, file_len, end, limit)?;

    let mut slots: Vec<Slot> = Vec::new();
    let mut skipped = 0u64;
    for (_, line) in &selected.records {
        match normalize_record(line) {
            Record::Slots(record_slots) => slots.extend(record_slots),
            Record::Silent => {}
            Record::Unrecognised => skipped += 1,
        }
    }

    let wanted: HashSet<String> = slots
        .iter()
        .filter_map(|slot| match slot {
            Slot::Call(call) => Some(call.call_id.clone()),
            Slot::Item(_) => None,
        })
        .collect();

    // **The page answers its own calls first.** A call and its result are
    // adjacent records, so on the newest page — the one that ends at EOF —
    // every pair is inside the page and the forward scan below finds nothing.
    // Skipping this pass is what makes a completed tool read as still running.
    let mut results: HashMap<String, ResultFact> = HashMap::new();
    let mut outstanding = wanted.len();
    for (_, line) in &selected.records {
        collect_results(line, &wanted, &mut results, &mut outstanding);
        if outstanding == 0 {
            break;
        }
    }

    // Then whatever is left, from beyond the page. `end` is where the page
    // stops, so everything from there on is strictly newer;
    // `scan_for_results` returns immediately at EOF, which is what makes an
    // in-flight call on the newest page `Running` without a special case.
    //
    // Only the *unanswered* ids are asked for, so a page that resolved
    // everything itself does no I/O at all — and, more importantly, does not
    // report `hit_cap` from a scan that had nothing to find.
    let unresolved: HashSet<String> = wanted
        .into_iter()
        .filter(|call_id| !results.contains_key(call_id))
        .collect();
    let mut scan = scan_for_results(&mut file, end, file_len, unresolved)?;
    scan.results.extend(results);

    Ok(PageV2 {
        items: materialize(slots, &scan),
        next_offset: selected.next_offset,
        has_more: selected.has_more,
        partial_tail: selected.partial_tail,
        skipped,
    })
}

/// Turn the page's slots into items, attaching results and bounding the bodies.
///
/// The page budget is spent in document order, so the degradation is
/// deterministic and a reader scrolling up sees the same tools cut every time —
/// not whichever ones happened to be materialized first.
fn materialize(slots: Vec<Slot>, scan: &ScanOutcome) -> Vec<ConversationItemV2> {
    let mut budget = PAGE_PAYLOAD_BUDGET;

    slots
        .into_iter()
        .map(|slot| match slot {
            Slot::Item(item) => item,
            Slot::Call(call) => {
                let fact = scan.results.get(&call.call_id);
                let status = match fact {
                    Some(fact) if fact.is_error => ToolStatusV2::Error,
                    Some(_) => ToolStatusV2::Success,
                    // No result, and the scan did not stop early: the call is
                    // simply the newest thing written.
                    None if !scan.hit_cap => ToolStatusV2::Running,
                    // No result, and the scan gave up. Deliberately not
                    // `Running` — see the module docs.
                    None => ToolStatusV2::Unknown,
                };

                let input = call
                    .input
                    .map(|payload| spend(&mut budget, payload, TOOL_INPUT_CEILING));
                let output = fact.map(|fact| {
                    spend(
                        &mut budget,
                        PayloadV2 {
                            text: fact.body.clone(),
                            kind: PayloadKindV2::Text,
                            truncated: false,
                        },
                        TOOL_OUTPUT_CEILING,
                    )
                });

                ConversationItemV2::Tool {
                    id: call.id,
                    timestamp: call.timestamp,
                    tool: ToolV2 {
                        call_id: call.call_id,
                        name: call.name,
                        status,
                        summary: call.summary,
                        input,
                        output,
                    },
                }
            }
        })
        .collect()
}

/// Cut one payload to what the page can still afford.
///
/// **The body is always present, even at zero budget** — emptied and marked
/// truncated rather than dropped. Dropping it would make "this response could
/// not carry it" indistinguishable from "the transcript did not record it",
/// which are the two things `skip_serializing_if` on the field is there to tell
/// apart.
fn spend(budget: &mut usize, mut payload: PayloadV2, ceiling: usize) -> PayloadV2 {
    let allowed = ceiling.min(*budget);
    let (text, cut) = truncate_bytes(&payload.text, allowed);
    *budget = budget.saturating_sub(text.len());
    payload.text = text;
    // Truncated if either limit cut it: the per-body ceiling or the page.
    payload.truncated = payload.truncated || cut;
    payload
}

/// Cut `s` to at most `max` **bytes**, on a character boundary.
///
/// Bytes rather than characters because the ceilings are about how much travels
/// on the wire, and a character count does not bound that — a run of CJK text is
/// three bytes per character. Cutting mid-character would produce a string the
/// client cannot decode, so the cut walks back to the nearest boundary.
fn truncate_bytes(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (s[..cut].to_string(), true)
}

/// What the forward scan found, and whether it stopped early.
struct ScanOutcome {
    results: HashMap<String, ResultFact>,
    /// The scan hit a cap with calls still unanswered. The difference between
    /// this and reaching EOF is the difference between `Unknown` and `Running`.
    hit_cap: bool,
}

/// Read forward from `from`, collecting results for the calls the page named.
///
/// Stops at the first of: every wanted call answered, `PAIR_SCAN_MAX_RECORDS`
/// parsed, `PAIR_SCAN_MAX_BYTES` read, or the end of the file.
///
/// The early stop is what keeps this cheap in the common case — a page whose
/// calls are all answered by the next record reads one chunk, not 256 KiB.
fn scan_for_results(
    file: &mut File,
    from: u64,
    file_len: u64,
    wanted: HashSet<String>,
) -> std::io::Result<ScanOutcome> {
    let mut results: HashMap<String, ResultFact> = HashMap::new();
    if wanted.is_empty() || from >= file_len {
        // Nothing to look for, or the page already reaches the end of the file.
        // Either way there is nothing newer to find, which is `Running` and not
        // `Unknown` — hence `hit_cap: false`.
        return Ok(ScanOutcome {
            results,
            hit_cap: false,
        });
    }

    let mut cursor = from;
    let mut read_bytes = 0u64;
    let mut parsed = 0usize;
    let mut outstanding = wanted.len();
    let mut carry = String::new();

    while cursor < file_len {
        let span = READ_CHUNK.min(file_len - cursor);
        let mut buf = vec![
            0u8;
            usize::try_from(span).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "scan chunk too large")
            })?
        ];
        file.seek(SeekFrom::Start(cursor))?;
        file.read_exact(&mut buf)?;
        cursor += span;
        read_bytes += span;

        carry.push_str(&String::from_utf8_lossy(&buf));

        // A record is one line, and the tail after the last newline is kept
        // back because it may be a record split across two reads — a
        // half-parsed `tool_result` is worse than none.
        //
        // The same pop handles the clean case: a chunk ending on a newline
        // leaves the empty string after it, which carries as nothing.
        let mut lines: Vec<&str> = carry.split('\n').collect();
        let tail = lines.pop().unwrap_or("").to_string();

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            parsed += 1;
            collect_results(line, &wanted, &mut results, &mut outstanding);
            // Both of these are checked *inside* the record loop, not after the
            // chunk. A chunk is 32 KiB and can hold hundreds of small records,
            // so a cap tested once per chunk is a cap on how much is read and
            // not on how far the scan looks — it would be exceeded by whatever
            // happened to fit, which is exactly the unboundedness the cap is
            // there to prevent.
            if outstanding == 0 {
                return Ok(ScanOutcome {
                    results,
                    hit_cap: false,
                });
            }
            if parsed >= PAIR_SCAN_MAX_RECORDS {
                return Ok(ScanOutcome {
                    results,
                    hit_cap: true,
                });
            }
        }
        carry = tail;

        if read_bytes >= PAIR_SCAN_MAX_BYTES {
            return Ok(ScanOutcome {
                results,
                hit_cap: true,
            });
        }
    }

    // Ran out of file rather than out of budget: whatever is still unanswered
    // has simply not been written yet.
    Ok(ScanOutcome {
        results,
        hit_cap: false,
    })
}

/// Pull any `tool_result` blocks out of one record that answer a wanted call.
fn collect_results(
    line: &str,
    wanted: &HashSet<String>,
    results: &mut HashMap<String, ResultFact>,
    outstanding: &mut usize,
) {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let Some(blocks) = record
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in blocks {
        if string_field(block, "type").as_deref() != Some("tool_result") {
            continue;
        }
        let Some(call_id) = string_field(block, "tool_use_id") else {
            continue;
        };
        if !wanted.contains(&call_id) || results.contains_key(&call_id) {
            continue;
        }
        results.insert(
            call_id,
            ResultFact {
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                body: result_body(block.get("content")),
            },
        );
        *outstanding = outstanding.saturating_sub(1);
    }
}

/// The text of a `tool_result`'s `content`.
///
/// Two shapes occur, as in a message's own `content`: a plain string, or a list
/// of blocks each carrying `text`. Both are flattened to text. A result that is
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

/// What one transcript record contributed to the page.
///
/// Three outcomes rather than two, because "understood and rendered as part of
/// something else" is not "not understood". `skipped` is what a client shows as
/// "some events were not displayed", so counting a paired `tool_result` there
/// would tell the user data was dropped when it is on screen inside the call it
/// belongs to.
enum Record {
    /// Rows to render.
    Slots(Vec<Slot>),
    /// A conversation record the reader understood and did not render on its own:
    /// a `tool_result` belongs to its call, and a record of only `thinking` was
    /// deliberately folded away. **Not** counted as skipped.
    Silent,
    /// A record this version does not model — bookkeeping, a subagent's turn, a
    /// message shape it cannot read. Counted, so a client can say the
    /// conversation is partial rather than presenting a hole as the whole.
    Unrecognised,
}

/// Turn one transcript record into the slots it contributes.
fn normalize_record(line: &str) -> Record {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return Record::Unrecognised;
    };
    let Some(kind) = string_field(&record, "type") else {
        return Record::Unrecognised;
    };
    if !crate::conversation::is_message_record(&kind) {
        return Record::Unrecognised;
    }
    // A subagent's records are not the main conversation.
    if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return Record::Unrecognised;
    }

    let Some(message) = record.get("message") else {
        return Record::Unrecognised;
    };
    let id = string_field(&record, "uuid").unwrap_or_default();
    let timestamp = string_field(&record, "timestamp");
    let role = if kind == "assistant" {
        RoleV2::Assistant
    } else {
        RoleV2::User
    };

    // `content` is either a plain string or a block list, and both occur — a
    // measured transcript had 62 string-bodied user turns, so accepting only the
    // list shape would drop real messages while looking like it worked.
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if text.trim().is_empty() {
            return Record::Silent;
        }
        return Record::Slots(vec![Slot::Item(ConversationItemV2::Message {
            id,
            timestamp,
            role,
            content: vec![ConversationContentV2::Text {
                text: text.to_string(),
            }],
        })]);
    }

    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return Record::Unrecognised;
    };

    let mut slots: Vec<Slot> = Vec::new();
    // Consecutive prose merges into one message, so a turn that wrote two
    // paragraphs is one bubble rather than two. A tool call ends the run: the
    // activity is *between* the prose on either side of it, which is the order
    // the blocks are in and the order a reader expects.
    let mut prose: Vec<ConversationContentV2> = Vec::new();
    let mut prose_starts_at: Option<usize> = None;
    let mut unmodelled = 0usize;
    // Whether anything a reader could use came out of this record. Distinct
    // from "produced no slots": a record of nothing but `tool_result` blocks
    // produces no slots and is not unreadable, it is paired.
    let mut readable = 0usize;

    let flush =
        |slots: &mut Vec<Slot>, prose: &mut Vec<ConversationContentV2>, at: &mut Option<usize>| {
            if prose.is_empty() {
                return;
            }
            let first = at.take().unwrap_or(0);
            slots.push(Slot::Item(ConversationItemV2::Message {
                id: item_id(&id, first),
                timestamp: timestamp.clone(),
                role,
                content: std::mem::take(prose),
            }));
        };

    for (index, block) in blocks.iter().enumerate() {
        match string_field(block, "type").as_deref() {
            Some("text") => {
                let Some(text) = string_field(block, "text") else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                if prose_starts_at.is_none() {
                    prose_starts_at = Some(index);
                }
                readable += 1;
                prose.push(ConversationContentV2::Text { text });
            }
            Some("tool_use") => {
                flush(&mut slots, &mut prose, &mut prose_starts_at);
                readable += 1;
                let name = string_field(block, "name").unwrap_or_else(|| "tool".to_string());
                let input = block.get("input");
                slots.push(Slot::Call(PendingCall {
                    id: item_id(&id, index),
                    timestamp: timestamp.clone(),
                    call_id: string_field(block, "id").unwrap_or_default(),
                    summary: tool_summary(&name, input),
                    input: input.map(|input| PayloadV2 {
                        text: serde_json::to_string_pretty(input).unwrap_or_default(),
                        kind: PayloadKindV2::Json,
                        truncated: false,
                    }),
                    name,
                }));
            }
            // `thinking` is folded away — it is model reasoning, not a turn, and
            // it is the largest block type in a measured transcript (650 blocks
            // against 355 `text`), so showing it would bury the conversation it
            // reasons about.
            //
            // `tool_result` is not a row either: it pairs with the call it
            // answers, and rendering both doubles the tool noise.
            Some("thinking") | Some("tool_result") => {}
            // Anything else is a block type this version does not model. The
            // position is kept rather than the content, so a message that
            // carried one does not read as if it had not.
            _ => {
                unmodelled += 1;
                if prose_starts_at.is_none() {
                    prose_starts_at = Some(index);
                }
                prose.push(ConversationContentV2::Unknown);
            }
        }
    }
    flush(&mut slots, &mut prose, &mut prose_starts_at);

    if readable > 0 {
        return Record::Slots(slots);
    }
    // Nothing readable came out. A record that was *all* unmodelled still
    // happened, and a hole the user cannot see is worse than a line saying
    // something was there — so it becomes the `Unknown` item rather than a
    // message whose entire body is an "unreadable" marker.
    //
    // The two are genuinely different states, which is why both exist: a
    // message containing an unmodelled block *beside* readable ones is a
    // partially-readable turn and keeps its bubble, while a record with nothing
    // readable in it is a marker and not a turn at all.
    if unmodelled > 0 {
        return Record::Slots(vec![Slot::Item(ConversationItemV2::Unknown {
            id,
            timestamp,
        })]);
    }
    // Understood, and nothing to draw: a `tool_result` awaiting its call, or a
    // record of nothing but `thinking`. Neither is an event the client failed to
    // show.
    Record::Silent
}

/// The item id for the block at `index` of record `id`.
///
/// The first block keeps the bare record uuid, as v1 did, so the common case
/// reads as the record it came from. Later blocks are suffixed with their index,
/// which is what keeps two `Bash` calls in one turn from colliding on a React
/// key — and stable across polls, because the index is a property of the
/// transcript rather than of the page.
fn item_id(record_id: &str, index: usize) -> String {
    if index == 0 {
        record_id.to_string()
    } else {
        format!("{record_id}#{index}")
    }
}

/// A bounded, single-line description of a tool call.
///
/// Specialized by name where a tool has an argument that *is* the call — a
/// `Read` is its path, a `Bash` is its command — and generic otherwise, so a
/// tool Claude adds next month reads as its own best argument rather than as
/// nothing. The specialization lives here rather than in the contract because
/// Claude's tool set is open: a client that knew these names would be a client
/// that breaks when the set changes.
fn tool_summary(name: &str, input: Option<&Value>) -> String {
    let described = input
        .and_then(|input| specialized(name, input))
        .unwrap_or_else(|| generic(input));
    truncate_chars(&collapse_whitespace(&described), TOOL_SUMMARY_CEILING)
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

/// Cut `s` to at most `max` characters, saying so when it does.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::conversation::v2::{ConversationResponseV2, ConversationStateV2};

    fn page_of(transcript: &str) -> PageV2 {
        page_of_limited(transcript, 100)
    }

    /// The same, asking for a specific number of records.
    fn page_of_limited(transcript: &str, limit: usize) -> PageV2 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // Every record ends with a newline, and a reader relies on that: the
        // element after the final newline is treated as a record still being
        // written and is *not* returned. A fixture without the trailing newline
        // is a transcript whose last record has not finished arriving, which is
        // a real state — but not the one these tests mean to set up.
        let body = if transcript.ends_with('\n') {
            transcript.to_string()
        } else {
            format!("{transcript}\n")
        };
        std::fs::write(&path, body).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");
        read_page(&discovered, None, limit).unwrap()
    }

    // Each of these is one line, and that is load-bearing rather than tidy: the
    // transcript is newline-delimited, so a record containing a literal newline
    // is two records, neither of them valid JSON. Written as one line to keep
    // the fixtures shaped like the format they stand for.
    fn message(id: &str, role: &str, content: Value) -> String {
        format!(
            r#"{{"type":"{role}","uuid":"{id}","timestamp":"2026-09-25T00:00:00Z","message":{{"role":"{role}","content":{content}}}}}"#
        )
    }

    fn call(call_id: &str, name: &str, input: Value) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"a-{call_id}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"{call_id}","name":"{name}","input":{input}}}]}}}}"#
        )
    }

    fn result(call_id: &str, body: &str, is_error: bool) -> String {
        format!(
            r#"{{"type":"user","uuid":"u-{call_id}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{call_id}","is_error":{is_error},"content":{body}}}]}}}}"#
        )
    }

    fn join(lines: &[String]) -> String {
        let mut out = lines.join("\n");
        out.push('\n');
        out
    }

    fn tools(page: &PageV2) -> Vec<&ToolV2> {
        page.items
            .iter()
            .filter_map(|item| match item {
                ConversationItemV2::Tool { tool, .. } => Some(tool),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_tool_call_and_its_successful_result_are_one_activity() {
        // The whole point of v2. v1 rendered the call as a row and dropped the
        // result, so nothing could ever say what a tool produced.
        let page = page_of(&join(&[
            call(
                "t1",
                "Read",
                serde_json::json!({"file_path": "src/main.rs"}),
            ),
            result("t1", "\"fn main() {}\"", false),
        ]));

        let tools = tools(&page);
        assert_eq!(tools.len(), 1, "the result became a second row");
        assert_eq!(tools[0].status, ToolStatusV2::Success);
        assert_eq!(tools[0].call_id, "t1");
        assert_eq!(
            tools[0].summary, "src/main.rs",
            "a Read summarizes as its path"
        );
        assert_eq!(
            tools[0].output.as_ref().map(|o| o.text.as_str()),
            Some("fn main() {}"),
            "the result body was not attached"
        );
    }

    #[test]
    fn an_error_result_sets_the_status_and_keeps_the_body() {
        // v1's `is_error` shipped hardcoded `false`, so a failing tool could
        // not be told from a succeeding one.
        let page = page_of(&join(&[
            call("t1", "Bash", serde_json::json!({"command": "cargo test"})),
            result("t1", "\"error: no such crate\"", true),
        ]));

        let tools = tools(&page);
        assert_eq!(tools[0].status, ToolStatusV2::Error);
        assert_eq!(
            tools[0].summary, "cargo test",
            "a Bash summarizes as its command"
        );
        assert_eq!(
            tools[0].output.as_ref().map(|o| o.text.as_str()),
            Some("error: no such crate"),
            "a failure's output is the part a reader needs most"
        );
    }

    #[test]
    fn a_call_with_no_result_yet_is_running_not_an_error() {
        // A live conversation's ordinary state, and the reason the status is an
        // enum rather than v1's boolean.
        let page = page_of(&call(
            "t1",
            "Bash",
            serde_json::json!({"command": "cargo build"}),
        ));

        let tools = tools(&page);
        assert_eq!(tools[0].status, ToolStatusV2::Running);
        assert!(
            tools[0].output.is_none(),
            "a running call has no output yet"
        );
    }

    #[test]
    fn a_pair_split_across_a_page_boundary_still_resolves() {
        // The case a per-record normalizer cannot solve, and the reason the
        // forward scan exists.
        //
        // The page genuinely has to *stop* between the call and its result. A
        // result is always newer than its call, so asking for the newest `n`
        // records of a short transcript puts both in the same page and proves
        // nothing — which is what an earlier version of this test did. The
        // offset below is the one fact that makes the split real.
        let head = format!(
            "{}\n{}\n",
            message("m1", "user", Value::String("go".into())),
            call("t1", "Bash", serde_json::json!({"command": "ls"})),
        );
        let page_end = head.len() as u64;
        let transcript = format!("{head}{}\n", result("t1", "\"a.rs b.rs\"", false));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, &transcript).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");

        // The page is everything before the result: the message and the call.
        let page = read_page(&discovered, Some(page_end), 2).unwrap();
        assert!(
            page.items
                .iter()
                .any(|item| matches!(item, ConversationItemV2::Tool { .. })),
            "the fixture did not put the call in the page: {:?}",
            page.items
        );

        let tools = tools(&page);
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].status,
            ToolStatusV2::Success,
            "a call whose result is on the next page reported {:?}",
            tools[0].status
        );
        assert_eq!(
            tools[0].output.as_ref().map(|o| o.text.as_str()),
            Some("a.rs b.rs"),
            "the result on the far side of the page boundary was not attached"
        );
    }

    #[test]
    fn an_orphan_result_does_not_become_a_row() {
        // A result whose call is on an older page is not this page's business.
        // Rendering it would put a tool with no call in the transcript.
        let page = page_of(&join(&[result("t-missing", "\"orphan\"", false)]));
        assert!(page.items.is_empty(), "an orphan result became a row");
    }

    #[test]
    fn the_newest_page_reports_running_rather_than_unknown() {
        // Both mean "no result", and the difference is what the provider is
        // claiming: `Running` says it is still going, `Unknown` says the read
        // did not look far enough. At EOF there is nothing newer to look at.
        let page = page_of(&call("t1", "Bash", serde_json::json!({"command": "sleep"})));
        assert_eq!(tools(&page)[0].status, ToolStatusV2::Running);
    }

    #[test]
    fn a_call_whose_result_lies_beyond_the_scan_reports_unknown_not_running() {
        // Past the scan's cap the provider cannot tell "still going" from "did
        // not look far enough", and must not guess the flattering one.
        //
        // The page has to be an *older* one: a result is always newer than its
        // call, so only a page that stops before the result can have one beyond
        // the scan. That is also the shape this is really about — a reader who
        // scrolled back into a long conversation.
        let head = format!(
            "{}\n{}\n",
            message("m1", "user", Value::String("go".into())),
            call("t1", "Bash", serde_json::json!({"command": "slow"})),
        );
        let page_end = head.len() as u64;

        let mut tail = String::new();
        for i in 0..(PAIR_SCAN_MAX_RECORDS + 10) {
            tail.push_str(&message(
                &format!("filler{i}"),
                "assistant",
                Value::String(format!("filler {i}")),
            ));
            tail.push('\n');
        }
        tail.push_str(&result("t1", "\"done\"", false));
        tail.push('\n');

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, format!("{head}{tail}")).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");

        let page = read_page(&discovered, Some(page_end), 2).unwrap();
        assert_eq!(tools(&page).len(), 1, "the page should hold the call");
        assert_eq!(
            tools(&page)[0].status,
            ToolStatusV2::Unknown,
            "a call past the scan cap claimed to be still running"
        );
    }

    #[test]
    fn thinking_stays_folded_away_and_does_not_become_content() {
        // The largest block type in a real transcript. Showing it would bury
        // the conversation it reasons about.
        let record = message(
            "a1",
            "assistant",
            serde_json::json!([
                {"type": "thinking", "thinking": "secret reasoning"},
                {"type": "text", "text": "the answer"}
            ]),
        );
        let page = page_of(&join(&[record]));

        assert_eq!(page.items.len(), 1);
        let ConversationItemV2::Message { content, role, .. } = &page.items[0] else {
            panic!("expected a message, got {:?}", page.items[0]);
        };
        assert_eq!(*role, RoleV2::Assistant);
        assert_eq!(
            content,
            &vec![ConversationContentV2::Text {
                text: "the answer".into()
            }],
            "reasoning leaked into the conversation"
        );
    }

    #[test]
    fn prose_around_a_tool_call_stays_on_the_sides_it_was_written() {
        // Order is the transcript's, not an arrangement: the reader needs to
        // see that the model said something, called a tool, then said more.
        let record = message(
            "a1",
            "assistant",
            serde_json::json!([
                {"type": "text", "text": "before"},
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
                {"type": "text", "text": "after"}
            ]),
        );
        let page = page_of(&join(&[record]));

        let shape: Vec<&str> = page
            .items
            .iter()
            .map(|item| match item {
                ConversationItemV2::Message { .. } => "message",
                ConversationItemV2::Tool { .. } => "tool",
                ConversationItemV2::Unknown { .. } => "unknown",
            })
            .collect();
        assert_eq!(shape, vec!["message", "tool", "message"]);
    }

    #[test]
    fn a_user_message_with_blocks_is_a_message_not_a_string() {
        // Both content shapes occur in real transcripts — 62 string-bodied user
        // turns in one measured sample — so accepting only one drops messages.
        let page = page_of(&join(&[message(
            "u1",
            "user",
            serde_json::json!([{"type": "text", "text": "block form"}]),
        )]));

        assert_eq!(page.items.len(), 1);
        let ConversationItemV2::Message { role, content, .. } = &page.items[0] else {
            panic!("expected a message");
        };
        assert_eq!(*role, RoleV2::User);
        assert_eq!(
            content,
            &vec![ConversationContentV2::Text {
                text: "block form".into()
            }]
        );
    }

    #[test]
    fn an_unmodelled_block_keeps_its_position_rather_than_vanishing() {
        // A message that carried something this version cannot read must not
        // render as if it had not.
        let record = message(
            "a1",
            "assistant",
            serde_json::json!([
                {"type": "text", "text": "seen"},
                {"type": "something_added_later", "payload": {}}
            ]),
        );
        let page = page_of(&join(&[record]));

        let ConversationItemV2::Message { content, .. } = &page.items[0] else {
            panic!("expected a message");
        };
        assert_eq!(
            content,
            &vec![
                ConversationContentV2::Text {
                    text: "seen".into()
                },
                ConversationContentV2::Unknown,
            ]
        );
    }

    #[test]
    fn a_message_of_nothing_but_unmodelled_blocks_is_reported_as_unknown() {
        // Not dropped: a hole the user cannot see is worse than a line saying
        // something was there.
        let record = message(
            "a1",
            "assistant",
            serde_json::json!([{"type": "brand_new_kind", "x": 1}]),
        );
        let page = page_of(&join(&[record]));

        assert!(
            matches!(page.items.as_slice(), [ConversationItemV2::Unknown { .. }]),
            "expected one unknown item, got {:?}",
            page.items
        );
    }

    #[test]
    fn a_bookkeeping_record_is_still_not_a_message() {
        for line in [
            r#"{"type":"attachment","uuid":"a","cwd":"/w"}"#,
            r#"{"type":"ai-title","aiTitle":"x"}"#,
            r#"{"type":"last-prompt","lastPrompt":"hi"}"#,
            r#"{"type":"queue-operation","operation":"x"}"#,
            "not json at all",
        ] {
            assert!(
                matches!(normalize_record(line), Record::Unrecognised),
                "a bookkeeping record became conversation: {line}"
            );
        }
    }

    #[test]
    fn a_sidechain_record_is_left_out() {
        let record = r#"{"type":"assistant","uuid":"a1","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}"#;
        assert!(matches!(normalize_record(record), Record::Unrecognised));
    }

    #[test]
    fn a_paired_tool_result_is_silent_rather_than_unrecognised() {
        // The distinction `skipped` turns on. A result the reader understood and
        // attached to its call is not an event that failed to display — counting
        // it would make a conversation whose every tool rendered report that
        // half its records were dropped.
        let record = r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]}}"#;
        assert!(
            matches!(normalize_record(record), Record::Silent),
            "a paired result was counted as an unread record"
        );
    }

    #[test]
    fn a_tool_result_is_never_a_row_even_when_it_carries_text() {
        let record = r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]}}"#;
        assert!(
            !matches!(normalize_record(record), Record::Slots(_)),
            "a tool result became a transcript row"
        );
    }

    #[test]
    fn skipped_counts_only_what_was_not_understood() {
        // End to end, because that is where it is shown: one bookkeeping record
        // around a rendered pair must report one skipped, not three.
        let page = page_of(&join(&[
            r#"{"type":"ai-title","aiTitle":"x"}"#.to_string(),
            call("t1", "Bash", serde_json::json!({"command": "ls"})),
            result("t1", "\"a.rs\"", false),
        ]));

        assert_eq!(
            page.skipped, 1,
            "the paired result and the rendered call were counted as dropped"
        );
        assert_eq!(tools(&page).len(), 1);
    }

    #[test]
    fn a_long_tool_body_is_cut_and_says_so() {
        let huge = "x".repeat(TOOL_OUTPUT_CEILING * 3);
        let page = page_of(&join(&[
            call("t1", "Bash", serde_json::json!({"command": "cat big"})),
            result("t1", &format!("\"{huge}\""), false),
        ]));

        let output = tools(&page)[0].output.clone().expect("output");
        assert!(
            output.text.len() <= TOOL_OUTPUT_CEILING,
            "an unbounded body reached the wire: {} bytes",
            output.text.len()
        );
        assert!(output.truncated, "a cut body must say it was cut");
    }

    #[test]
    fn the_page_budget_bounds_the_whole_response_and_degrades_loudly() {
        // The per-body ceiling bounds one tool; only this bounds the page. Ten
        // tools at the ceiling would otherwise be ten times the ceiling.
        let body = "y".repeat(TOOL_OUTPUT_CEILING);
        let mut lines = Vec::new();
        for i in 0..20 {
            lines.push(call(
                &format!("t{i}"),
                "Bash",
                serde_json::json!({"command": format!("cmd {i}")}),
            ));
            lines.push(result(&format!("t{i}"), &format!("\"{body}\""), false));
        }
        let page = page_of(&join(&lines));

        let carried: usize = tools(&page)
            .iter()
            .filter_map(|tool| tool.output.as_ref())
            .map(|output| output.text.len())
            .sum();
        assert!(
            carried <= PAGE_PAYLOAD_BUDGET,
            "the page carried {carried} bytes against a {PAGE_PAYLOAD_BUDGET} budget"
        );
        // And the tools that could not be carried are still there, saying so —
        // a page that silently lost them would read as a shorter conversation.
        let cut = tools(&page)
            .iter()
            .filter(|tool| tool.output.as_ref().is_some_and(|o| o.truncated))
            .count();
        assert!(cut > 0, "nothing was marked truncated, so nothing was cut");
        assert_eq!(tools(&page).len(), 20, "a tool was dropped rather than cut");
    }

    #[test]
    fn a_cut_stops_on_a_character_boundary() {
        // Three-byte characters: a byte-bounded cut that ignored boundaries
        // would produce a string the client cannot decode.
        let s = "中".repeat(100);
        let (cut, truncated) = truncate_bytes(&s, 10);
        assert!(truncated);
        assert_eq!(cut.len(), 9, "cut mid-character: {cut:?}");
        assert_eq!(cut, "中中中");
    }

    #[test]
    fn a_multiline_command_summarizes_as_one_line() {
        // The summary is a line in a collapsed row; newlines would wrap it or
        // be clipped, and neither says what the command was.
        let page = page_of(&call(
            "t1",
            "Bash",
            serde_json::json!({"command": "cargo test \\\n  -p foo \\\n  -- --nocapture"}),
        ));
        let summary = &tools(&page)[0].summary;
        assert!(
            !summary.contains('\n'),
            "the summary carried a newline: {summary:?}"
        );
        assert!(summary.starts_with("cargo test"), "got {summary:?}");
    }

    #[test]
    fn an_unknown_tool_summarizes_by_its_arguments_rather_than_nothing() {
        // Claude's tool set is open. A tool added next month must read as
        // something, which is what the generic fallback is for.
        let page = page_of(&call(
            "t1",
            "SomeFutureTool",
            serde_json::json!({"beta": 1, "alpha": 2}),
        ));
        assert_eq!(tools(&page)[0].summary, "alpha, beta");
    }

    #[test]
    fn the_input_payload_is_json_and_pretty_printed() {
        // `[object Object]` is the failure this exists to prevent: JSON input
        // has to arrive as something a code block can show.
        let page = page_of(&call(
            "t1",
            "Read",
            serde_json::json!({"file_path": "a.rs", "limit": 5}),
        ));
        let input = tools(&page)[0].input.clone().expect("input");
        assert_eq!(input.kind, PayloadKindV2::Json);
        assert!(
            input.text.contains("\"file_path\": \"a.rs\""),
            "got {}",
            input.text
        );
        assert!(!input.text.contains("[object"), "got {}", input.text);
    }

    #[test]
    fn page_metadata_still_says_where_the_next_page_starts() {
        let transcript = join(&[
            message("m1", "user", Value::String("one".into())),
            message("m2", "assistant", Value::String("two".into())),
            message("m3", "user", Value::String("three".into())),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, &transcript).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");

        let page = read_page(&discovered, None, 2).unwrap();
        assert!(page.has_more);
        assert!(page.next_offset.is_some());
        assert_eq!(page.items.len(), 2, "the newest two records");

        // And walking back reaches the rest, exactly once.
        let older = read_page(&discovered, page.next_offset, 2).unwrap();
        assert!(!older.has_more);
        assert_eq!(older.items.len(), 1);
    }

    #[test]
    fn a_reader_that_found_nothing_answers_with_no_items() {
        // The shape the handler falls back to for every non-`Ready` state.
        let not_found = ConversationResponseV2::bare(ConversationStateV2::NotFound);
        assert!(not_found.items.is_empty());
        assert!(not_found.conversation.is_none());
        assert!(!not_found.has_more);
    }
}
