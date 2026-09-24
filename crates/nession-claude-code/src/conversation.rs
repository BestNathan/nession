//! Finding a Session's conversation on disk, and normalizing it (#1005).
//!
//! Two jobs, both of which exist to keep Claude Code's file format inside this
//! crate:
//!
//! 1. **Discovery** — which transcripts belong to a given working directory.
//! 2. **Normalization** — turning transcript records into conversation items.
//!
//! ## Discovery matches the record's own `cwd`, never the directory name
//!
//! Claude stores transcripts under `~/.claude/projects/<something>/<id>.jsonl`,
//! and `<something>` looks like the cwd with separators replaced. It is not a
//! usable index: measured over 39 transcripts, **10 sat in a directory that does
//! not correspond to their own `cwd`** field (a `resume`, or a session whose cwd
//! changed, leaves the file where it was). One path even contained `+`.
//!
//! So this reads each transcript's recorded `cwd` and compares it exactly.
//! `#1005` decision 7 requires strict matching — no parent, no git root, no
//! subdirectory — and matching the wrong field would have made that rule
//! unenforceable while looking enforced.
//!
//! ## Normalization is lossy on purpose
//!
//! A measured transcript carried, besides messages: `attachment`,
//! `atis-latch`, `worktree-state`, `last-prompt`, `mode`, `permission-mode`,
//! `relocated`, `pr-link`, `ai-title`, `file-history-delta`,
//! `file-history-snapshot`, `queue-operation`, `system`. None is a chat turn,
//! and rendering them as rows is the failure criterion 4 names. They are
//! skipped — and *counted*, so a client can tell "nothing was missed" from
//! "this version does not model what it saw".

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::protocol::conversation::v1::{
    ConversationItemV1, ItemKindV1, ToolV1, TOOL_SUMMARY_CEILING,
};

/// Claude's record types that carry conversation.
const MESSAGE_TYPES: [&str; 2] = ["user", "assistant"];

/// How much to read at a time while scanning backwards for a page boundary.
const READ_CHUNK: u64 = 64 * 1024;

/// A conversation found on disk.
///
/// The transcript's path is deliberately **not** part of the public shape: it
/// is how this module reaches the file, not something a caller learns.
#[derive(Debug, Clone)]
pub struct Discovered {
    /// Claude's own session id for this conversation.
    pub claude_session_id: String,
    /// The cwd the transcript itself recorded.
    pub cwd: String,
    /// Newest timestamp seen, when the transcript carried timestamps.
    pub updated_at: Option<String>,
    path: PathBuf,
}

impl Discovered {
    /// The transcript this conversation lives in.
    ///
    /// Crate-internal: the response shape has no path field, and the only way
    /// this leaves the crate is through this accessor inside it.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// One page of a conversation, plus what the reader had to say about the file.
#[derive(Debug, Clone, Default)]
pub struct Page {
    pub items: Vec<ConversationItemV1>,
    /// Byte offset to pass back to read the page before this one.
    pub next_offset: Option<u64>,
    pub has_more: bool,
    /// The file ended mid-record. Normal for a transcript being appended to.
    pub partial_tail: bool,
    /// Records this module did not model.
    pub skipped: u64,
}

/// Every transcript whose recorded `cwd` is exactly `cwd`.
///
/// Sorted newest-first by the transcript's own last timestamp, which is a
/// *listing* order and not a selection: nothing here chooses a conversation,
/// it only orders the candidates a user is about to choose from (#1005
/// decision 3 — no mtime heuristic).
pub fn conversations_at(cwd: &str) -> Vec<Discovered> {
    let Some(root) = projects_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for project in entries.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(found_one) = inspect(&path, cwd) {
                found.push(found_one);
            }
        }
    }

    // Newest first for the list. `None` timestamps sort last rather than
    // first: a transcript with no timestamp is not evidence of recency.
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    found
}

/// `~/.claude/projects`.
fn projects_dir() -> Option<PathBuf> {
    crate::security::claude_home_dir().map(|home| home.join("projects"))
}

/// Read just enough of `path` to decide whether it is `cwd`'s conversation.
///
/// Only the head and tail are read — the head for `cwd` and the session id,
/// the tail for the newest timestamp — so a directory of large transcripts does
/// not turn into a directory of full reads.
fn inspect(path: &Path, cwd: &str) -> Option<Discovered> {
    let mut file = File::open(path).ok()?;

    // Read through `take` rather than a fixed array plus a slice: the slice
    // bound is the kind of thing that is correct until someone edits the
    // constant above it.
    let mut head = Vec::new();
    file.by_ref().take(16 * 1024).read_to_end(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head);

    let mut claude_session_id = None;
    let mut recorded_cwd = None;
    for line in head.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            // A partial final line in the head window is expected; keep going.
            continue;
        };
        if claude_session_id.is_none() {
            claude_session_id = string_field(&record, "sessionId");
        }
        if recorded_cwd.is_none() {
            recorded_cwd = string_field(&record, "cwd");
        }
        if claude_session_id.is_some() && recorded_cwd.is_some() {
            break;
        }
    }

    // Strict equality, on the value the transcript recorded — see the module
    // docs for why the containing directory cannot stand in for this.
    let recorded_cwd = recorded_cwd?;
    if recorded_cwd != cwd {
        return None;
    }
    // A transcript with no session id cannot be selected or cached against, so
    // it is not a candidate. Falling back to the filename would invent an
    // identity the transcript never claimed.
    let claude_session_id = claude_session_id?;

    Some(Discovered {
        claude_session_id,
        cwd: recorded_cwd,
        updated_at: newest_timestamp(path),
        path: path.to_path_buf(),
    })
}

/// The newest `timestamp` in the transcript's last chunk.
fn newest_timestamp(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(READ_CHUNK);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = String::new();
    file.read_to_string(&mut tail).ok()?;

    tail.lines()
        .filter_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|r| string_field(&r, "timestamp"))
        })
        .next_back()
}

/// A page of `conversation`, ending at `end_offset` (or at the end of the file).
///
/// Reads **backwards** from the end: the newest items are what a reader wants
/// first (#1005 criterion 5), and a transcript can be far larger than anything
/// worth holding in memory. Only the bytes needed for the page are read.
pub fn read_page(
    conversation: &Discovered,
    end_offset: Option<u64>,
    limit: usize,
) -> std::io::Result<Page> {
    let mut file = File::open(conversation.path())?;
    let file_len = file.metadata()?.len();
    let end = end_offset.unwrap_or(file_len).min(file_len);

    // Records newest-first, each with the byte offset it starts at. The offset
    // is what makes the cursor exact: a page boundary that landed mid-record
    // would show one item twice, or lose it between pages.
    let mut page = Page::default();
    let mut records: Vec<(u64, String)> = Vec::new();
    let mut cursor = end;
    let mut partial_tail = false;
    let mut first_chunk = true;

    while cursor > 0 && records.len() <= limit {
        // Begin every chunk at a record boundary, so a record is never split
        // across two reads and each line's offset is computable.
        let start = align_to_record(&mut file, cursor.saturating_sub(READ_CHUNK))?;
        if start >= cursor {
            // Alignment found no boundary before `cursor`; the remaining bytes
            // are one fragment, which only the file's own start can complete.
            break;
        }

        let span = usize::try_from(cursor - start).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "transcript chunk too large",
            )
        })?;
        let mut buf = vec![0u8; span];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;
        let text = String::from_utf8_lossy(&buf).into_owned();

        let lines: Vec<&str> = text.split('\n').collect();
        let last_index = lines.len().saturating_sub(1);
        let mut offset = start;
        // Oldest-first within this chunk, then pushed onto `records` in reverse
        // so that `records` is newest-first overall — which is what "take the
        // first `limit`" has to mean.
        let mut chunk: Vec<(u64, String)> = Vec::new();

        for (index, line) in lines.iter().enumerate() {
            if index > 0 {
                // +1 for the newline that separated this line from the last.
                offset += 1;
            }
            let line_start = offset;
            offset += line.len() as u64;

            // The element after the final newline: empty when the chunk ends
            // cleanly, or a record still being written when it ends at EOF.
            if index == last_index {
                if end == file_len && !line.trim().is_empty() && first_chunk {
                    partial_tail = true;
                }
                break;
            }
            if line.trim().is_empty() {
                continue;
            }
            chunk.push((line_start, line.to_string()));
        }

        records.extend(chunk.into_iter().rev());
        first_chunk = false;
        cursor = start;
    }

    // The newest `limit` records form the page; older ones are the next page.
    // The page reads oldest-first, which is the order a conversation is read in.
    let take = records.len().min(limit);
    let mut selected: Vec<&(u64, String)> = records.get(..take).unwrap_or(&[]).iter().collect();
    selected.reverse();

    for (_, line) in &selected {
        match normalize_line(line) {
            Normalized::Items(items) => page.items.extend(items),
            Normalized::Skipped => page.skipped += 1,
        }
    }

    // Continue from the oldest record this page showed; everything before it is
    // strictly older and cannot repeat a row.
    page.has_more = records.len() > take;
    page.next_offset = if page.has_more {
        selected.first().map(|(offset, _)| *offset)
    } else {
        None
    };
    page.partial_tail = partial_tail;
    Ok(page)
}

/// The next byte offset at or after `from` that begins a record.
///
/// A record begins at the file's first byte, or immediately after a newline.
/// Aligning here is what lets every line in a chunk be treated as complete.
fn align_to_record(file: &mut File, from: u64) -> std::io::Result<u64> {
    if from == 0 {
        return Ok(0);
    }
    let mut cursor = from;
    let mut probe = [0u8; 1];
    // Scanning back to a newline is bounded in practice by the longest record,
    // and a record is one JSONL line.
    while cursor > 0 {
        cursor -= 1;
        file.seek(SeekFrom::Start(cursor))?;
        file.read_exact(&mut probe)?;
        if probe[0] == b'\n' {
            return Ok(cursor + 1);
        }
    }
    Ok(0)
}

/// What one transcript line turned into.
enum Normalized {
    Items(Vec<ConversationItemV1>),
    Skipped,
}

/// Turn one transcript record into conversation items.
///
/// Anything this version does not model is `Skipped` — the transcript is
/// append-only and upstream adds record types, so an unrecognised line is
/// ordinary, not corruption (#1005 constraint 7).
fn normalize_line(line: &str) -> Normalized {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return Normalized::Skipped;
    };

    let Some(kind) = string_field(&record, "type") else {
        return Normalized::Skipped;
    };
    if !MESSAGE_TYPES.contains(&kind.as_str()) {
        return Normalized::Skipped;
    }
    // A subagent's records are not the main conversation. Edge case in #1005:
    // "v1 不应错误地把 subagent transcript 当主 conversation".
    if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return Normalized::Skipped;
    }

    let Some(message) = record.get("message") else {
        return Normalized::Skipped;
    };
    let id = string_field(&record, "uuid").unwrap_or_default();
    let timestamp = string_field(&record, "timestamp");

    let kind_of = |record_kind: &str| {
        if record_kind == "assistant" {
            ItemKindV1::Assistant
        } else {
            ItemKindV1::User
        }
    };

    // `content` is either a plain string or a block list. Both occur: a measured
    // transcript had 62 string-bodied user turns, so accepting only the list
    // shape would drop real messages while looking like it worked.
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if text.trim().is_empty() {
            return Normalized::Skipped;
        }
        return Normalized::Items(vec![ConversationItemV1 {
            id,
            kind: kind_of(&kind),
            timestamp,
            text: Some(text.to_string()),
            tool: None,
        }]);
    }

    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return Normalized::Skipped;
    };

    let mut items = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let block_kind = string_field(block, "type").unwrap_or_default();
        let item_id = if index == 0 {
            id.clone()
        } else {
            format!("{id}#{index}")
        };
        match block_kind.as_str() {
            "text" => {
                let Some(text) = string_field(block, "text") else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                items.push(ConversationItemV1 {
                    id: item_id,
                    kind: kind_of(&kind),
                    timestamp: timestamp.clone(),
                    text: Some(text),
                    tool: None,
                });
            }
            "tool_use" => {
                let name = string_field(block, "name").unwrap_or_else(|| "tool".to_string());
                let summary = tool_summary(block.get("input"));
                items.push(ConversationItemV1 {
                    id: item_id,
                    kind: ItemKindV1::Tool,
                    timestamp: timestamp.clone(),
                    text: None,
                    tool: Some(ToolV1 {
                        name,
                        summary,
                        is_error: false,
                        truncated: false,
                    }),
                });
            }
            // `thinking` is folded away: it is model reasoning, not a turn, and
            // it is the second-largest block type in a real transcript. Showing
            // it by default would bury the conversation.
            //
            // `tool_result` is not a row either — it pairs with the `tool_use`
            // it answers, and rendering both doubles the tool noise.
            _ => {}
        }
    }

    if items.is_empty() {
        Normalized::Skipped
    } else {
        Normalized::Items(items)
    }
}

/// A bounded, single-line description of a tool call's input.
///
/// Never the payload: `#1005` bounds resource use and requires tool output not
/// to drown the conversation. The value is summarized by its shape — how many
/// keys, or a short scalar — rather than by copying whatever is in it.
fn tool_summary(input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    let described = match input {
        Value::Object(map) => {
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.sort_unstable();
            keys.join(", ")
        }
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    truncate(&described, TOOL_SUMMARY_CEILING)
}

/// Cut `s` to at most `max` characters, saying so when it does.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}…")
}

/// A string field, when the record carries one.
fn string_field(record: &Value, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item_texts(line: &str) -> Vec<(ItemKindV1, Option<String>)> {
        match normalize_line(line) {
            Normalized::Items(items) => items.into_iter().map(|i| (i.kind, i.text)).collect(),
            Normalized::Skipped => Vec::new(),
        }
    }

    #[test]
    fn a_bookkeeping_record_is_not_a_message() {
        // Measured real shapes. Each of these is a real record type from a live
        // transcript, and none is a chat turn — rendering them is exactly what
        // #1005 criterion 4 forbids.
        for line in [
            r#"{"type":"attachment","uuid":"a","cwd":"/w"}"#,
            r#"{"type":"atis-latch","atis":true,"sessionId":"s"}"#,
            r#"{"type":"mode","mode":"default","sessionId":"s"}"#,
            r#"{"type":"permission-mode","permissionMode":"acceptEdits"}"#,
            r#"{"type":"file-history-snapshot","messageId":"m"}"#,
            r#"{"type":"queue-operation","operation":"x"}"#,
            r#"{"type":"last-prompt","lastPrompt":"hi"}"#,
            r#"{"type":"worktree-state","worktreeSession":{}}"#,
            r#"{"type":"pr-link","sessionId":"s"}"#,
        ] {
            assert!(
                matches!(normalize_line(line), Normalized::Skipped),
                "bookkeeping record became a message: {line}"
            );
        }
    }

    #[test]
    fn a_user_turn_is_a_message() {
        let line = r#"{"type":"user","uuid":"u1","timestamp":"2026-09-25T00:00:00Z",
                       "message":{"role":"user","content":"hello"}}"#;
        assert_eq!(
            item_texts(line),
            vec![(ItemKindV1::User, Some("hello".to_string()))]
        );
    }

    #[test]
    fn assistant_text_becomes_one_item_and_thinking_does_not() {
        // `thinking` is the second-largest block type in a real transcript.
        // Making it a row would bury the conversation it is reasoning about.
        let line = r#"{"type":"assistant","uuid":"a1",
                       "message":{"role":"assistant","content":[
                         {"type":"thinking","thinking":"secret reasoning"},
                         {"type":"text","text":"the answer"}]}}"#;
        assert_eq!(
            item_texts(line),
            vec![(ItemKindV1::Assistant, Some("the answer".to_string()))],
            "reasoning leaked into the conversation as a turn"
        );
    }

    #[test]
    fn a_tool_call_becomes_one_collapsible_item_without_its_payload() {
        let line = r#"{"type":"assistant","uuid":"a2",
                       "message":{"role":"assistant","content":[
                         {"type":"tool_use","id":"t1","name":"Bash",
                          "input":{"command":"rm -rf /","description":"danger"}}]}}"#;
        let Normalized::Items(items) = normalize_line(line) else {
            panic!("a tool_use is an item");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, ItemKindV1::Tool);
        let tool = items[0].tool.as_ref().expect("tool detail");
        assert_eq!(tool.name, "Bash");
        assert!(
            !tool.summary.contains("rm -rf"),
            "the tool's payload was copied into the summary: {}",
            tool.summary
        );
    }

    #[test]
    fn a_tool_result_is_not_a_second_row() {
        // Paired with the call it answers; rendering both doubles tool noise.
        let line = r#"{"type":"user","uuid":"u2",
                       "message":{"role":"user","content":[
                         {"type":"tool_result","tool_use_id":"t1","content":"output"}]}}"#;
        assert!(item_texts(line).is_empty());
    }

    #[test]
    fn a_sidechain_record_is_left_out_of_the_main_conversation() {
        let line = r#"{"type":"assistant","uuid":"a3","isSidechain":true,
                       "message":{"role":"assistant","content":[
                         {"type":"text","text":"subagent work"}]}}"#;
        assert!(
            item_texts(line).is_empty(),
            "a subagent's record was shown as the main conversation"
        );
    }

    #[test]
    fn an_unknown_record_kind_is_skipped_rather_than_failing_the_read() {
        // Upstream adds record types; an unrecognised one must not make the
        // whole conversation unopenable.
        for line in [
            r#"{"type":"something-added-later","payload":{}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"new_block_kind"}]}}"#,
            "not json at all",
            "",
        ] {
            assert!(
                matches!(normalize_line(line), Normalized::Skipped),
                "an unmodelled line took the read down: {line}"
            );
        }
    }

    #[test]
    fn a_long_tool_summary_is_bounded_and_says_so() {
        let long = "k".repeat(TOOL_SUMMARY_CEILING * 3);
        let summary = tool_summary(Some(&Value::String(long)));
        assert!(summary.chars().count() <= TOOL_SUMMARY_CEILING + 1);
        assert!(summary.ends_with('…'), "a cut summary must say it was cut");
    }

    #[test]
    fn truncate_leaves_a_short_string_alone() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }

    // ---- paging ---------------------------------------------------------

    /// A user turn, as one transcript line.
    fn turn(n: usize) -> String {
        format!(
            r#"{{"type":"user","uuid":"u{n}","timestamp":"2026-09-25T00:00:{n:02}Z","cwd":"/w","sessionId":"s","message":{{"role":"user","content":"message {n}"}}}}"#
        )
    }

    fn transcript(dir: &Path, body: &str) -> Discovered {
        let path = dir.join("s.jsonl");
        std::fs::write(&path, body).expect("write the transcript");
        Discovered {
            claude_session_id: "s".to_string(),
            cwd: "/w".to_string(),
            updated_at: None,
            path,
        }
    }

    /// Walk every page backwards, newest first, and return the texts in
    /// conversation order.
    fn page_through(conversation: &Discovered, page_size: usize) -> Vec<String> {
        let mut pages = Vec::new();
        let mut offset = None;
        loop {
            let page = read_page(conversation, offset, page_size).expect("read a page");
            let texts: Vec<String> = page.items.iter().filter_map(|i| i.text.clone()).collect();
            pages.push(texts);
            match page.next_offset {
                Some(next) => offset = Some(next),
                None => break,
            }
        }
        // Pages arrive newest-first; within a page, oldest-first.
        pages.reverse();
        pages.into_iter().flatten().collect()
    }

    #[test]
    fn the_newest_page_comes_back_and_reads_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (0..5).map(|n| format!("{}\n", turn(n))).collect();
        let conversation = transcript(dir.path(), &body);

        let page = read_page(&conversation, None, 3).unwrap();
        let texts: Vec<String> = page.items.iter().filter_map(|i| i.text.clone()).collect();
        assert_eq!(
            texts,
            vec!["message 2", "message 3", "message 4"],
            "the first page is the newest items, ordered for reading"
        );
        assert!(page.has_more, "there are older items");
    }

    #[test]
    fn walking_every_page_yields_each_item_exactly_once() {
        // The property a page seam is most likely to break: an offset that
        // lands mid-record either duplicates an item or loses one, and both
        // look like a plausible conversation.
        let dir = tempfile::tempdir().unwrap();
        let body: String = (0..25).map(|n| format!("{}\n", turn(n))).collect();
        let conversation = transcript(dir.path(), &body);

        let expected: Vec<String> = (0..25).map(|n| format!("message {n}")).collect();
        for page_size in [1, 2, 3, 7, 24, 25, 40] {
            assert_eq!(
                page_through(&conversation, page_size),
                expected,
                "paging with page_size={page_size} lost, duplicated or reordered items"
            );
        }
    }

    #[test]
    fn a_partial_trailing_record_is_reported_and_the_finished_ones_still_render() {
        // Normal while Claude is writing. #1005 criterion 6: the completed
        // messages still show, and the read is not an error.
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            "{}\n{}\n{{\"type\":\"user\",\"uuid\":\"x\",\"mess",
            turn(0),
            turn(1)
        );
        let conversation = transcript(dir.path(), &body);

        let page = read_page(&conversation, None, 10).unwrap();
        let texts: Vec<String> = page.items.iter().filter_map(|i| i.text.clone()).collect();
        assert_eq!(texts, vec!["message 0", "message 1"]);
        assert!(
            page.partial_tail,
            "a half-written last line must be reported, not silently ignored"
        );
    }

    #[test]
    fn a_cleanly_terminated_transcript_is_not_reported_as_partial() {
        let dir = tempfile::tempdir().unwrap();
        let conversation = transcript(dir.path(), &format!("{}\n", turn(0)));
        let page = read_page(&conversation, None, 10).unwrap();
        assert!(!page.partial_tail);
    }

    #[test]
    fn unmodelled_records_are_counted_rather_than_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            "{}\n{}\n{}\n",
            turn(0),
            r#"{"type":"mode","mode":"default","sessionId":"s"}"#,
            r#"{"type":"something-new","sessionId":"s"}"#
        );
        let conversation = transcript(dir.path(), &body);
        let page = read_page(&conversation, None, 10).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            page.skipped, 2,
            "a client must be able to tell it missed something"
        );
    }

    #[test]
    fn a_transcript_bigger_than_one_read_chunk_pages_without_duplicating() {
        // Crosses the READ_CHUNK boundary in both directions: the alignment and
        // offset arithmetic only get exercised once a chunk boundary exists.
        let dir = tempfile::tempdir().unwrap();
        let padding = "p".repeat(4096);
        let body: String = (0..60)
            .map(|n| {
                format!(
                    r#"{{"type":"user","uuid":"u{n}","cwd":"/w","sessionId":"s","message":{{"role":"user","content":"message {n} {padding}"}}}}"#
                ) + "\n"
            })
            .collect();
        let conversation = transcript(dir.path(), &body);

        let walked = page_through(&conversation, 7);
        assert_eq!(
            walked.len(),
            60,
            "chunk-crossing pages lost or duplicated items"
        );
        for (index, text) in walked.iter().enumerate() {
            assert!(
                text.starts_with(&format!("message {index} ")),
                "item {index} came back as {text:.40}"
            );
        }
    }
}
