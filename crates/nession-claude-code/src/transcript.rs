//! The **transcript projection**: what a session actually did (#1234).
//!
//! The conversation projection's counterpart, over the same canonical page. The
//! two differ in exactly one way, and it is the reason both exist: the
//! conversation *filters* — it draws turns and tools and hides reasoning,
//! attachments, runtime events and session state — and this *maps*, drawing
//! every entry the parser understood. Neither parses anything itself; that is
//! [`crate::canonical`]'s job, once.
//!
//! ## Nothing is hidden, and unknown is the load-bearing kind
//!
//! An entry this version cannot model is drawn as [`TranscriptEntryV1::Unknown`]
//! with its upstream name intact, rather than omitted. A hole a reader cannot
//! see is worse than a line saying something was there — and measured against a
//! real corpus where upstream carries 18 record types, 7 `system` subtypes and
//! ~30 attachment types, it is also how a Claude upgrade becomes *observable*:
//! new records appear as unknowns and move the parse counts, instead of silently
//! changing what the page means.
//!
//! ## Bounds are this layer's job, and they are the same bounds
//!
//! The ceilings and the page budget belong to the contracts, not to the
//! canonical layer, whose job is to report what the transcript says. They are
//! applied here through [`crate::payload`] — shared with the conversation
//! projection, because they bound bodies of the *same records* and a second copy
//! of the arithmetic could disagree about what a page may carry.

use std::io;

use crate::canonical::{
    read_page as read_canonical, CanonicalPage, Entry, MessageSource, ParseStats, ToolStatus,
};
use crate::conversation::Discovered;
use crate::payload::{spend, truncate_chars};
use crate::protocol::messages::v1::{
    MessageContentV1, ToolActivityV1, ToolStatusV1, PAGE_PAYLOAD_BUDGET, TOOL_INPUT_CEILING,
    TOOL_OUTPUT_CEILING, TOOL_SUMMARY_CEILING,
};
use crate::protocol::transcript_items::v1::{
    EventCategoryV1, MessageSourceV1, TranscriptEntryV1, ATTACHMENT_CEILING, REASONING_CEILING,
};

/// One page of a transcript's timeline.
#[derive(Debug, Clone, Default)]
pub struct TranscriptPage {
    /// Oldest-first within the page, in transcript order.
    pub items: Vec<TranscriptEntryV1>,
    /// Byte offset to pass back to read the page before this one.
    pub next_offset: Option<u64>,
    pub has_more: bool,
    /// The transcript ended mid-record when it was read. Not an error.
    pub partial_tail: bool,
    /// What the parser understood, which is the transcript view's answer to
    /// "is this everything?" — the counts, not a single skipped number.
    pub stats: ParseStats,
}

/// A page of `claude-code.transcript-items` for one transcript.
pub fn read_page(
    conversation: &Discovered,
    end_offset: Option<u64>,
    limit: usize,
) -> io::Result<TranscriptPage> {
    let page = read_canonical(conversation, end_offset, limit)?;
    Ok(project(&page))
}

/// Draw a canonical page as a transcript.
///
/// The page budget is spent in document order, so degradation is deterministic:
/// a reader scrolling up sees the same bodies cut every time, not whichever ones
/// happened to be materialized first.
fn project(page: &CanonicalPage) -> TranscriptPage {
    let mut budget = PAGE_PAYLOAD_BUDGET;
    let items = page
        .entries
        .iter()
        .map(|entry| item_of(entry, &mut budget))
        .collect();

    TranscriptPage {
        items,
        next_offset: page.next_offset,
        has_more: page.has_more,
        partial_tail: page.partial_tail,
        stats: page.stats,
    }
}

/// One canonical entry as a transcript item.
///
/// Every arm yields an item. A `match` that could not is what the conversation
/// projection looks like, and the difference is the whole contract.
fn item_of(entry: &Entry, budget: &mut usize) -> TranscriptEntryV1 {
    match entry {
        Entry::Message(message) => TranscriptEntryV1::Message {
            id: message.id.clone(),
            timestamp: message.timestamp.clone(),
            source: match message.source {
                MessageSource::Human => MessageSourceV1::Human,
                MessageSource::Assistant => MessageSourceV1::Assistant,
                MessageSource::Synthetic => MessageSourceV1::Synthetic,
                MessageSource::System => MessageSourceV1::System,
            },
            content: message
                .content
                .iter()
                .map(|block| match block {
                    crate::canonical::MessageBlock::Text { text } => {
                        MessageContentV1::Text { text: text.clone() }
                    }
                    crate::canonical::MessageBlock::Unknown => MessageContentV1::Unknown,
                })
                .collect(),
        },
        // A subagent's turn is drawn here rather than filtered, which is correct
        // for this view and wrong for the other: the transcript of a session
        // that delegated *did* contain those turns, and this view is the one
        // that says so.
        Entry::ToolCall(call) => TranscriptEntryV1::Tool {
            id: call.id.clone(),
            timestamp: call.timestamp.clone(),
            tool: ToolActivityV1 {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                status: match call.status {
                    ToolStatus::Running => ToolStatusV1::Running,
                    ToolStatus::Success => ToolStatusV1::Success,
                    ToolStatus::Error => ToolStatusV1::Error,
                    ToolStatus::Unknown => ToolStatusV1::Unknown,
                },
                summary: truncate_chars(&call.summary, TOOL_SUMMARY_CEILING),
                input: call
                    .input
                    .as_ref()
                    .map(|payload| spend(budget, payload, TOOL_INPUT_CEILING)),
                output: call
                    .output
                    .as_ref()
                    .map(|payload| spend(budget, payload, TOOL_OUTPUT_CEILING)),
            },
        },
        Entry::Reasoning(reasoning) => TranscriptEntryV1::Reasoning {
            id: reasoning.id.clone(),
            timestamp: reasoning.timestamp.clone(),
            reasoning_type: reasoning.reasoning_type.clone(),
            text: spend(
                budget,
                &crate::canonical::Payload {
                    text: reasoning.text.clone(),
                    is_json: false,
                    truncated: false,
                },
                REASONING_CEILING,
            ),
        },
        Entry::Attachment(attachment) => TranscriptEntryV1::Attachment {
            id: attachment.id.clone(),
            timestamp: attachment.timestamp.clone(),
            attachment_type: attachment.attachment_type.clone(),
            payload: attachment
                .payload
                .as_ref()
                .map(|payload| spend(budget, payload, ATTACHMENT_CEILING)),
        },
        Entry::Runtime(event) => TranscriptEntryV1::Event {
            id: event.id.clone(),
            timestamp: event.timestamp.clone(),
            category: match event.category {
                crate::canonical::EventCategory::System => EventCategoryV1::System,
                crate::canonical::EventCategory::Runtime => EventCategoryV1::Runtime,
                crate::canonical::EventCategory::Lifecycle => EventCategoryV1::Lifecycle,
                crate::canonical::EventCategory::Checkpoint => EventCategoryV1::Checkpoint,
            },
            name: event.name.clone(),
        },
        Entry::Metadata(event) => TranscriptEntryV1::Metadata {
            id: event.id.clone(),
            timestamp: event.timestamp.clone(),
            name: event.name.clone(),
        },
        Entry::Unknown(unknown) => TranscriptEntryV1::Unknown {
            id: unknown.id.clone(),
            timestamp: unknown.timestamp.clone(),
            upstream_type: unknown.upstream_type.clone(),
            upstream_subtype: unknown.upstream_subtype.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::messages::v1::ToolStatusV1;
    use crate::protocol::transcript_items::v1::{ATTACHMENT_CEILING, REASONING_CEILING};

    /// One page of a transcript written to a temporary file.
    fn page_of(body: &str) -> TranscriptPage {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, body).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");
        read_page(&discovered, None, 200).unwrap()
    }

    fn kinds(page: &TranscriptPage) -> Vec<&'static str> {
        page.items
            .iter()
            .map(|item| match item {
                TranscriptEntryV1::Message { .. } => "message",
                TranscriptEntryV1::Tool { .. } => "tool",
                TranscriptEntryV1::Reasoning { .. } => "reasoning",
                TranscriptEntryV1::Attachment { .. } => "attachment",
                TranscriptEntryV1::Event { .. } => "event",
                TranscriptEntryV1::Metadata { .. } => "metadata",
                TranscriptEntryV1::Unknown { .. } => "unknown",
            })
            .collect()
    }

    #[test]
    fn every_broad_kind_reaches_the_page() {
        // The property that *is* the difference between the two projections: the
        // conversation filters, this maps. Every record here is one a real
        // corpus carries, and the conversation projection draws only two of the
        // seven kinds.
        let body = concat!(
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"weighing"},{"type":"text","text":"answer"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
            "\n",
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a.rs"}]}}"#,
            "\n",
            r#"{"type":"attachment","uuid":"att1","attachment":{"type":"hook_success"}}"#,
            "\n",
            r#"{"type":"system","uuid":"s1","subtype":"turn_duration","durationMs":4200}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"a title"}"#,
            "\n",
            r#"{"type":"quantum-entanglement-state","uuid":"q1"}"#,
            "\n",
        );
        let page = page_of(body);

        let mut seen = kinds(&page);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(
            seen,
            vec![
                "attachment",
                "event",
                "message",
                "metadata",
                "reasoning",
                "tool",
                "unknown"
            ],
            "a kind the parser understood was not drawn: {:?}",
            page.items
        );
    }

    #[test]
    fn a_synthetic_turn_is_drawn_here_even_though_the_conversation_hides_it() {
        // The exact inverse of the conversation projection's rule, and the
        // reason the two views need one canonical model rather than two parsers:
        // same record, same classification, opposite policy.
        let body = concat!(
            r#"{"type":"user","uuid":"m1","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"injected context"}]}}"#,
            "\n",
        );
        let page = page_of(body);

        let [TranscriptEntryV1::Message { source, .. }] = page.items.as_slice() else {
            panic!("expected one message, got {:?}", page.items);
        };
        assert_eq!(*source, MessageSourceV1::Synthetic);
        assert!(
            page.items.iter().any(|item| item.id() == "m1"),
            "the injected turn was dropped: {:?}",
            page.items
        );
    }

    #[test]
    fn a_reasoning_block_is_drawn_with_its_upstream_type() {
        // The largest block type in a real transcript, and one the conversation
        // never draws. `reasoning_type` stays a string so a new member of the
        // family needs no new model.
        let body = concat!(
            r#"{"type":"assistant","uuid":"r1","message":{"role":"assistant","content":[{"type":"redacted_thinking","data":"opaque"}]}}"#,
            "\n",
        );
        let page = page_of(body);

        let [TranscriptEntryV1::Reasoning {
            reasoning_type,
            text,
            ..
        }] = page.items.as_slice()
        else {
            panic!("expected reasoning, got {:?}", page.items);
        };
        assert_eq!(reasoning_type, "redacted_thinking");
        assert_eq!(text.text, "opaque");
    }

    #[test]
    fn an_oversized_reasoning_body_is_cut_and_says_so() {
        // Measured, reasoning runs to 126 KB with 2.6% of blocks over the
        // ceiling — so this is the common tail, not a hypothetical.
        let huge = "r".repeat(REASONING_CEILING * 3);
        let line = serde_json::json!({
            "type": "assistant",
            "uuid": "r1",
            "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": huge}
            ]},
        })
        .to_string();
        let page = page_of(&format!("{line}\n"));

        let [TranscriptEntryV1::Reasoning { text, .. }] = page.items.as_slice() else {
            panic!("expected reasoning");
        };
        assert!(
            text.text.len() <= REASONING_CEILING,
            "{} bytes",
            text.text.len()
        );
        assert!(text.truncated, "a cut body must say it was cut");
    }

    #[test]
    fn an_oversized_attachment_body_is_cut_rather_than_embedded() {
        // Measured, the largest attachment record is 1.2 MB — more than an
        // entire page may carry. Without the ceiling one record could exhaust
        // the budget for every other item on the page.
        let huge = "a".repeat(ATTACHMENT_CEILING * 4);
        let line = serde_json::json!({
            "type": "attachment",
            "uuid": "att1",
            "attachment": {"type": "file", "content": huge},
        })
        .to_string();
        let page = page_of(&format!("{line}\n"));

        let [TranscriptEntryV1::Attachment { payload, .. }] = page.items.as_slice() else {
            panic!("expected an attachment, got {:?}", page.items);
        };
        let payload = payload.as_ref().expect("the body is carried");
        assert!(
            payload.text.len() <= ATTACHMENT_CEILING,
            "{} bytes travelled",
            payload.text.len()
        );
        assert!(payload.truncated, "a cut body must say it was cut");
    }

    #[test]
    fn the_page_budget_bounds_the_whole_response() {
        // The per-item ceilings bound one item; only this bounds the page. With
        // the transcript view drawing *everything*, this is the bound that
        // matters most here.
        let body = "b".repeat(ATTACHMENT_CEILING);
        let lines: String = (0..40)
            .map(|i| {
                serde_json::json!({
                    "type": "attachment",
                    "uuid": format!("att{i}"),
                    "attachment": {"type": "file", "content": body},
                })
                .to_string()
                    + "\n"
            })
            .collect();
        let page = page_of(&lines);

        let carried: usize = page
            .items
            .iter()
            .filter_map(|item| match item {
                TranscriptEntryV1::Attachment { payload, .. } => {
                    payload.as_ref().map(|p| p.text.len())
                }
                _ => None,
            })
            .sum();
        assert!(
            carried <= PAGE_PAYLOAD_BUDGET,
            "the page carried {carried} bytes against a {PAGE_PAYLOAD_BUDGET} budget"
        );
        assert!(
            page.items
                .iter()
                .any(|item| matches!(item, TranscriptEntryV1::Attachment { payload: Some(p), .. } if p.truncated)),
            "nothing was marked truncated, so nothing was cut"
        );
    }

    #[test]
    fn a_page_carries_the_parse_accounting_through() {
        // The transcript view's answer to "is this everything?" is the counts,
        // not one number that cannot tell absorbed from unreadable.
        let body = concat!(
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"a title"}"#,
            "\n",
            r#"{"type":"quantum-entanglement-state","uuid":"q1"}"#,
            "\n",
            "not json at all\n",
        );
        let page = page_of(body);

        assert_eq!(page.stats.raw_records, 4);
        assert_eq!(page.stats.recognized_records, 1);
        assert_eq!(page.stats.metadata_absorbed, 1);
        assert_eq!(page.stats.unknown_records, 1);
        assert_eq!(page.stats.invalid_records, 1);
    }

    #[test]
    fn a_new_upstream_record_type_needs_no_new_protocol_generation() {
        // #1234's compatibility requirement, as an assertion rather than a hope.
        // A record type this version has never seen is carried *with its upstream
        // name*, the page still answers, and the contract that carried it is
        // still v1 — which is what "the subtype is data" has to mean if it means
        // anything. If a Claude release could force a new wire generation, the
        // `unknown` kind would not be doing its job.
        let body = concat!(
            r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":"hi"}}"#,
            "\n",
            r#"{"type":"quantum-entanglement-state","subtype":"collapsed","uuid":"q1"}"#,
            "\n",
        );
        let page = page_of(body);

        let unknown = page
            .items
            .iter()
            .find_map(|item| match item {
                TranscriptEntryV1::Unknown {
                    upstream_type,
                    upstream_subtype,
                    ..
                } => Some((upstream_type.clone(), upstream_subtype.clone())),
                _ => None,
            })
            .expect("the unknown record is drawn rather than dropped");
        assert_eq!(
            unknown.0.as_deref(),
            Some("quantum-entanglement-state"),
            "the record type this version does not know was not named"
        );
        assert_eq!(unknown.1.as_deref(), Some("collapsed"));
        assert_eq!(page.stats.unknown_records, 1);

        let descriptor = crate::protocol::transcript_items::v1::descriptor().unwrap();
        assert_eq!(
            descriptor.contracts.len(),
            1,
            "one unknown record type produced a second contract"
        );
        assert_eq!(
            descriptor.contracts[0].version,
            nession_protocol::ContractVersion::V1,
            "carrying an unknown record type moved the wire generation"
        );
    }

    #[test]
    fn session_state_records_without_a_uuid_still_get_distinct_items() {
        // Measured, 129,829 records carry no uuid — every session-state and
        // checkpoint record among them. Identity falls back to the record's byte
        // position, and two such records in one page must not collide: a client
        // keying identity reuse on the id would otherwise see one item where
        // there were two.
        let body = concat!(
            r#"{"type":"ai-title","aiTitle":"one"}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"two"}"#,
            "\n",
        );
        let page = page_of(body);

        let ids: Vec<&str> = page.items.iter().map(TranscriptEntryV1::id).collect();
        assert_eq!(ids.len(), 2, "{:?}", page.items);
        assert_ne!(ids[0], ids[1], "two records shared one identity: {ids:?}");
        assert!(
            ids.iter().all(|id| id.starts_with("offset:")),
            "a record with no uuid did not fall back to its position: {ids:?}"
        );
    }

    #[test]
    fn a_tool_pair_split_across_a_page_boundary_still_resolves() {
        // One of the shapes #1234 requires a fixture for, at the layer this
        // stage adds. Pairing happens once, in `canonical::read`, so the
        // conversation projection already covers the mechanism — but the
        // transcript is a different reader of the result, and a page that drew
        // the call without its output would read as a tool that produced
        // nothing.
        //
        // The page has to *genuinely* stop between the two: a result is always
        // newer than its call, so asking for the newest records of a short
        // transcript puts both in one page and proves nothing. The offset below
        // is what makes the split real.
        let head = concat!(
            r#"{"type":"user","uuid":"m1","message":{"role":"user","content":"go"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
            "\n",
        );
        let page_end = head.len() as u64;
        let result = r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a.rs"}]}}"#;
        let transcript = format!("{head}{result}\n");

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, &transcript).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");

        let page = read_page(&discovered, Some(page_end), 2).unwrap();
        let tool = page
            .items
            .iter()
            .find_map(|item| match item {
                TranscriptEntryV1::Tool { tool, .. } => Some(tool),
                _ => None,
            })
            .expect("the page holds the call");
        assert_eq!(
            tool.status,
            ToolStatusV1::Success,
            "a call whose result is on the next page reported {:?}",
            tool.status
        );
        assert_eq!(
            tool.output.as_ref().map(|o| o.text.as_str()),
            Some("a.rs"),
            "the result on the far side of the page boundary was not attached"
        );
    }

    #[test]
    fn a_partial_trailing_record_is_reported_and_the_finished_ones_still_render() {
        // Normal while Claude is writing. The completed items still show, the
        // read is not an error, and — the part that matters for this view — the
        // unfinished record does not become a fabricated item.
        let body = concat!(
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"one"}}"#,
            "\n",
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"two"}}"#,
            "\n",
            r#"{"type":"user","uuid":"u3","mess"#,
        );
        let page = page_of(body);

        assert_eq!(page.items.len(), 2, "an unfinished record became an item");
        assert!(
            page.partial_tail,
            "a half-written last line must be reported"
        );
    }
}
