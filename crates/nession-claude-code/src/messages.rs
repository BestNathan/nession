//! The **conversation projection**: what a reader sees of a transcript (#1234).
//!
//! This module does not read Claude's JSONL and does not know a Claude field
//! name. [`crate::canonical`] reads the file once and says what is in it; this
//! decides what of that a person reading a conversation should see, and how much
//! of it one response may carry.
//!
//! ## What it draws, and what it deliberately does not
//!
//! A conversation is optimized for reading, not for completeness. A human or
//! assistant turn is a row; a tool call is one row paired with its result; and
//! reasoning, attachments, runtime events and session state are **facts the
//! transcript has and this view does not draw**. They are not missing — the
//! transcript projection shows them — and the distinction between "understood and
//! not drawn" and "could not be read" is what [`MessagesPage::skipped`] means.
//!
//! Two source kinds are also not drawn: a subagent's turns, which belong to a
//! sidechain rather than to this conversation, and turns the runtime produced
//! rather than a human (`MessageSource::System`, `MessageSource::Synthetic`).
//! The second is a correctness rule and not a display preference: `type: "user"`
//! is an envelope that carries injected context and background-task
//! notifications, and rendering those as things the user said is simply wrong
//! about who spoke.
//!
//! ## Payload bounds are this layer's job
//!
//! The ceilings are properties of *this contract* — how much one response may
//! carry — so they are applied here and not in the canonical layer, whose job is
//! to report what the transcript says. A tool body is bounded three times over:
//! [`TOOL_SUMMARY_CEILING`] on the collapsed line, [`TOOL_INPUT_CEILING`] /
//! [`TOOL_OUTPUT_CEILING`] on one body, and [`PAGE_PAYLOAD_BUDGET`] on the page,
//! because 200 tools at the per-body ceiling is 3.2 MB and no single-item limit
//! prevents that.

use crate::canonical::{read_page as read_canonical, CanonicalPage, Entry, MessageSource};
use crate::conversation::Discovered;
use crate::payload::{spend, truncate_chars};
use crate::protocol::messages::v1::{
    MessageContentV1, MessageItemV1, MessageRoleV1, ToolActivityV1, ToolStatusV1,
    PAGE_PAYLOAD_BUDGET, TOOL_INPUT_CEILING, TOOL_OUTPUT_CEILING, TOOL_SUMMARY_CEILING,
};

/// One page of a conversation's normalized timeline.
#[derive(Debug, Clone, Default)]
pub struct MessagesPage {
    pub items: Vec<MessageItemV1>,
    /// Byte offset to pass back to read the page before this one.
    pub next_offset: Option<u64>,
    pub has_more: bool,
    /// The file ended mid-record. Normal for a transcript being appended to.
    pub partial_tail: bool,
    /// Records the reader could not model — the only sense in which this view is
    /// incomplete. A record it understood and did not draw is not counted here.
    pub skipped: u64,
}

/// A page of `claude-code.messages` items for one conversation.
pub fn read_page(
    conversation: &Discovered,
    end_offset: Option<u64>,
    limit: usize,
) -> std::io::Result<MessagesPage> {
    let page = read_canonical(conversation, end_offset, limit)?;
    Ok(project(&page))
}

/// Draw a canonical page as a conversation.
///
/// The page budget is spent in document order, so the degradation is
/// deterministic and a reader scrolling up sees the same tools cut every time —
/// not whichever ones happened to be materialized first.
fn project(page: &CanonicalPage) -> MessagesPage {
    let mut budget = PAGE_PAYLOAD_BUDGET;
    let items = page
        .entries
        .iter()
        .filter_map(|entry| item_of(entry, &mut budget))
        .collect();

    MessagesPage {
        items,
        next_offset: page.next_offset,
        has_more: page.has_more,
        partial_tail: page.partial_tail,
        skipped: page.stats.unread(),
    }
}

/// One canonical entry as a conversation row, or `None` when this view does not
/// draw it.
fn item_of(entry: &Entry, budget: &mut usize) -> Option<MessageItemV1> {
    match entry {
        Entry::Message(message) => {
            // A subagent's turns are a different conversation's, and a turn the
            // runtime produced is not something a person said. Neither is drawn
            // here; both are facts the transcript view has.
            if message.sidechain {
                return None;
            }
            let role = match message.source {
                MessageSource::Human => MessageRoleV1::User,
                MessageSource::Assistant => MessageRoleV1::Assistant,
                MessageSource::Synthetic | MessageSource::System => return None,
            };
            // A turn whose every block was unmodelled is a marker and not a
            // turn: a hole the reader cannot see is worse than a line saying
            // something was there.
            if message
                .content
                .iter()
                .all(|block| matches!(block, crate::canonical::MessageBlock::Unknown))
            {
                return Some(MessageItemV1::Unknown {
                    id: message.id.clone(),
                    timestamp: message.timestamp.clone(),
                });
            }
            let content = message
                .content
                .iter()
                .map(|block| match block {
                    crate::canonical::MessageBlock::Text { text } => {
                        MessageContentV1::Text { text: text.clone() }
                    }
                    crate::canonical::MessageBlock::Unknown => MessageContentV1::Unknown,
                })
                .collect();
            Some(MessageItemV1::Message {
                id: message.id.clone(),
                timestamp: message.timestamp.clone(),
                role,
                content,
            })
        }
        Entry::ToolCall(call) => {
            let status = match call.status {
                crate::canonical::ToolStatus::Running => ToolStatusV1::Running,
                crate::canonical::ToolStatus::Success => ToolStatusV1::Success,
                crate::canonical::ToolStatus::Error => ToolStatusV1::Error,
                crate::canonical::ToolStatus::Unknown => ToolStatusV1::Unknown,
            };
            let input = call
                .input
                .as_ref()
                .map(|payload| spend(budget, payload, TOOL_INPUT_CEILING));
            let output = call
                .output
                .as_ref()
                .map(|payload| spend(budget, payload, TOOL_OUTPUT_CEILING));
            Some(MessageItemV1::Tool {
                id: call.id.clone(),
                timestamp: call.timestamp.clone(),
                tool: ToolActivityV1 {
                    call_id: call.call_id.clone(),
                    name: call.name.clone(),
                    status,
                    summary: truncate_chars(&call.summary, TOOL_SUMMARY_CEILING),
                    input,
                    output,
                },
            })
        }
        // Understood, and not this view's to draw. The transcript projection
        // shows all four; the conversation folds session state into its header
        // and leaves the rest to the surface that exists for completeness.
        //
        // `Entry::Unknown` is in here too: the reader could not model the
        // record, and this view's answer is to say so in `skipped` rather than
        // to put a row it cannot describe in front of someone reading a
        // conversation.
        Entry::Reasoning(_)
        | Entry::Attachment(_)
        | Entry::Runtime(_)
        | Entry::Metadata(_)
        | Entry::Unknown(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::messages::v1::{MessagesResponseV1, MessagesStateV1, PayloadKindV1};
    use serde_json::Value;

    fn page_of(transcript: &str) -> MessagesPage {
        page_of_limited(transcript, 100)
    }

    /// The same, asking for a specific number of records.
    fn page_of_limited(transcript: &str, limit: usize) -> MessagesPage {
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

    fn tools(page: &MessagesPage) -> Vec<&ToolActivityV1> {
        page.items
            .iter()
            .filter_map(|item| match item {
                MessageItemV1::Tool { tool, .. } => Some(tool),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_tool_call_and_its_successful_result_are_one_activity() {
        // The whole point of the pairing pass: rendering the call as a row and
        // dropping the result means nothing could ever say what a tool produced.
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
        assert_eq!(tools[0].status, ToolStatusV1::Success);
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
        assert_eq!(tools[0].status, ToolStatusV1::Error);
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
        assert_eq!(tools[0].status, ToolStatusV1::Running);
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
                .any(|item| matches!(item, MessageItemV1::Tool { .. })),
            "the fixture did not put the call in the page: {:?}",
            page.items
        );

        let tools = tools(&page);
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].status,
            ToolStatusV1::Success,
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
        assert_eq!(tools(&page)[0].status, ToolStatusV1::Running);
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
        //
        // The scan and its cap live in `canonical::read` now, so what this pins
        // is that the distinction survives the projection: `Unknown` is not
        // flattened into `Running` on the way to the wire.
        let head = format!(
            "{}\n{}\n",
            message("m1", "user", Value::String("go".into())),
            call("t1", "Bash", serde_json::json!({"command": "slow"})),
        );
        let page_end = head.len() as u64;

        let mut tail = String::new();
        for i in 0..(crate::canonical::read::PAIR_SCAN_MAX_RECORDS + 10) {
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
            ToolStatusV1::Unknown,
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
        let MessageItemV1::Message { content, role, .. } = &page.items[0] else {
            panic!("expected a message, got {:?}", page.items[0]);
        };
        assert_eq!(*role, MessageRoleV1::Assistant);
        assert_eq!(
            content,
            &vec![MessageContentV1::Text {
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
                MessageItemV1::Message { .. } => "message",
                MessageItemV1::Tool { .. } => "tool",
                MessageItemV1::Unknown { .. } => "unknown",
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
        let MessageItemV1::Message { role, content, .. } = &page.items[0] else {
            panic!("expected a message");
        };
        assert_eq!(*role, MessageRoleV1::User);
        assert_eq!(
            content,
            &vec![MessageContentV1::Text {
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

        let MessageItemV1::Message { content, .. } = &page.items[0] else {
            panic!("expected a message");
        };
        assert_eq!(
            content,
            &vec![
                MessageContentV1::Text {
                    text: "seen".into()
                },
                MessageContentV1::Unknown,
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
            matches!(page.items.as_slice(), [MessageItemV1::Unknown { .. }]),
            "expected one unknown item, got {:?}",
            page.items
        );
    }

    #[test]
    fn a_sidechain_record_is_left_out() {
        // A subagent's turn is a fact about the session and not a row in this
        // conversation. Which source *kind* it is, and that it is a sidechain at
        // all, is settled below in `canonical::adapter`; what is asserted here is
        // that this view does not draw it.
        let record = r#"{"type":"assistant","uuid":"a1","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}"#;
        let page = page_of(&join(&[record.to_string()]));
        assert!(
            page.items.is_empty(),
            "a subagent's turn became a row: {:?}",
            page.items
        );
    }

    #[test]
    fn a_meta_user_record_is_not_a_human_turn() {
        // Measured over 170 real transcripts / 58,350 `type=user` records: **700**
        // carry `isMeta: true` alongside text content, and this normalizer never
        // read the flag — so every one of them rendered as a turn the user had
        // typed.
        //
        // `isMeta` is Claude Code's own statement that it wrote the record as
        // context for the model rather than reading it from a human. It is a
        // fact about the record's *origin*, which is exactly why it is read from
        // the record instead of being recognized in the message text.
        let record = r#"{"type":"user","uuid":"m1","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Caveat: the messages below were generated by the user while running local commands"}]}}"#;
        let page = page_of(&join(&[record.to_string()]));

        assert!(
            page.items.is_empty(),
            "an injected meta record rendered as a human turn: {:?}",
            page.items
        );
    }

    #[test]
    fn a_notification_user_record_is_not_a_human_turn() {
        // 1,499 measured records arrive as `type=user` because a background task
        // finished, and Claude Code declares that origin — `origin.kind:
        // "task-notification"`, with `promptSource: "system"`. The declaration is
        // what this reads; the text is not, for the reason the counter-test
        // below records.
        let record = r#"{"type":"user","uuid":"n1","promptSource":"system","origin":{"kind":"task-notification"},"message":{"role":"user","content":[{"type":"text","text":"<task-notification>Background command completed</task-notification>"}]}}"#;
        let page = page_of(&join(&[record.to_string()]));

        assert!(
            page.items.is_empty(),
            "a task notification rendered as a human turn: {:?}",
            page.items
        );
    }

    #[test]
    fn a_user_record_without_a_declared_origin_is_still_a_human_turn() {
        // The counter-test to the two above, and the reason they classify on a
        // *declared* origin rather than on the text.
        //
        // 509 measured text-bearing `type=user` records carry no provenance field
        // at all, and they are not one class: 185 are slash-command expansions a
        // human typed, 181 are interruption markers, 59 are local-command output,
        // 81 are ordinary prose. Nothing in the record separates the first from
        // the third, so a classifier reading the text would hide real turns — and
        // losing a user's own message is a worse failure than showing one line of
        // bookkeeping. An undeclared record therefore stays human.
        //
        // The declared-human markers are in here too: they are the ones a stricter
        // reading would be tempted to drop along with the notifications they share
        // fields with (`promptSource` is carried by both).
        for record in [
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"typed with no provenance fields"}]}}"#,
            r#"{"type":"user","uuid":"u2","promptSource":"typed","origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":"declared human"}]}}"#,
            r#"{"type":"user","uuid":"u3","promptSource":"queued","origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":"queued while Claude was working"}]}}"#,
            r#"{"type":"user","uuid":"u4","promptSource":"suggestion_accepted","origin":{"kind":"human"},"turnOrigin":"human","message":{"role":"user","content":[{"type":"text","text":"accepted suggestion"}]}}"#,
        ] {
            let page = page_of(&join(&[record.to_string()]));
            assert_eq!(page.items.len(), 1, "a human turn was hidden: {record}");
            assert!(
                matches!(
                    page.items[0],
                    MessageItemV1::Message {
                        role: MessageRoleV1::User,
                        ..
                    }
                ),
                "a human turn stopped being a user message: {:?}",
                page.items[0]
            );
        }
    }

    #[test]
    fn a_tool_result_is_never_a_row_even_when_it_carries_text() {
        // It belongs to its call, and rendering both would double the tool noise.
        // End to end rather than at the adapter, because what a reader sees is
        // the assertion: the page shows the call and not a second row.
        let page = page_of(&join(&[
            call("t1", "Bash", serde_json::json!({"command": "ls"})),
            result("t1", "\"output\"", false),
        ]));

        assert_eq!(page.items.len(), 1, "the result became a second row");
        let items = page
            .items
            .iter()
            .filter(|item| matches!(item, MessageItemV1::Message { .. }))
            .count();
        assert_eq!(items, 0, "the result became a message row");
    }

    #[test]
    fn skipped_counts_only_what_was_not_understood() {
        // End to end, because that is where it is shown. The number turns on
        // telling two things apart: a record the reader *understood and did not
        // draw* — a paired `tool_result`, an `ai-title` — and a record it could
        // not read at all.
        //
        // Measured, the distinction is the whole number. In the newest
        // 50-record window of 134 real transcripts the median page carries **25**
        // records that are neither user nor assistant (max 40, and 58 of the 134
        // are over half), and every one of them was counted here. A conversation
        // was therefore announcing that half of itself had been dropped when
        // nothing had.
        let page = page_of(&join(&[
            r#"{"type":"ai-title","aiTitle":"x"}"#.to_string(),
            r#"{"type":"quantum-entanglement-state","uuid":"q1"}"#.to_string(),
            call("t1", "Bash", serde_json::json!({"command": "ls"})),
            result("t1", "\"a.rs\"", false),
        ]));

        assert_eq!(
            page.skipped, 1,
            "only the unreadable record is a record the reader could not read"
        );
        assert_eq!(tools(&page).len(), 1);
    }

    #[test]
    fn the_records_a_real_page_is_mostly_made_of_are_understood_not_dropped() {
        // Every type here is one measured in a real corpus (170 transcripts /
        // 387,851 records), and together they are the bulk of what a page holds:
        // `attachment` alone is 69,729 records, `queue-operation` 5,424,
        // `file-history-*` 5,891, `system` 4,381.
        //
        // None of them is a conversation row, and none of them is a record the
        // reader failed to read. They are two different facts.
        let page = page_of(&join(&[
            r#"{"type":"attachment","uuid":"a1","attachment":{"type":"hook_success"}}"#.to_string(),
            r#"{"type":"system","uuid":"s1","subtype":"turn_duration","durationMs":4200}"#
                .to_string(),
            r#"{"type":"mode","mode":"plan"}"#.to_string(),
            r#"{"type":"permission-mode","permissionMode":"plan"}"#.to_string(),
            r#"{"type":"queue-operation","operation":"enqueue"}"#.to_string(),
            r#"{"type":"file-history-snapshot","uuid":"f1","snapshot":{}}"#.to_string(),
            r#"{"type":"pr-link","prNumber":1301,"prUrl":"https://example.invalid/1301"}"#
                .to_string(),
            r#"{"type":"agent-name","agentName":"explore"}"#.to_string(),
        ]));

        assert_eq!(
            page.skipped, 0,
            "a record the reader understood was reported as one it could not read"
        );
        assert!(
            page.items.is_empty(),
            "one of these became a conversation row: {:?}",
            page.items
        );
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
        assert_eq!(input.kind, PayloadKindV1::Json);
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
        let not_found = MessagesResponseV1::bare(MessagesStateV1::NotFound);
        assert!(not_found.items.is_empty());
        assert!(not_found.conversation.is_none());
        assert!(!not_found.has_more);
    }
}
