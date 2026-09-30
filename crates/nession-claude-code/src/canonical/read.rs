//! One page of a transcript, as canonical entries (#1234).
//!
//! This is where a page is chosen, every record in it is adapted, and tool calls
//! are paired with their results. All three happen **below** the projections, so
//! the conversation and the transcript see the same page assembled the same way
//! and there is exactly one place a pairing bug can live.
//!
//! ## Pairing cannot be per-record, and the scan is why
//!
//! A `tool_use` block and its `tool_result` are different records, so a tool
//! cannot report what it produced unless the two are paired by `tool_use.id`.
//! Pages are read **backwards** from the end of an append-only file, so a call
//! can be the last record of one page while its result is the first record of
//! the next — a per-record normalizer sees each half alone and can only ever call
//! both halves orphans.
//!
//! So the page is selected first, and then scanned **forward** past its own end
//! for the results it is missing. The scan is bounded, and the bound is measured
//! rather than guessed: over 1180 real tool calls the gap between a call and its
//! result was min 1, p50 2, p90 7, p99 12, max **17** records (max 51 KB).
//! [`PAIR_SCAN_MAX_BYTES`] is an order of magnitude over the p99, so in practice
//! the scan resolves everything and stops early on the "every call answered"
//! condition rather than on the cap.
//!
//! When it *does* stop at the cap with calls outstanding, those calls report
//! [`ToolStatus::Unknown`] — not `Running`. "We did not look far enough" and "it
//! is still going" are different facts, and a provider that presents the first
//! as the second is making a claim it cannot support.
//!
//! ## What this layer does *not* do
//!
//! It does not bound payloads. The ceilings are properties of a wire contract —
//! how much one response may carry — and the projection that owns that contract
//! applies them. This layer reports what the transcript says.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use crate::canonical::adapter::{adapt, Fact, Outcome, PendingCall};
use crate::canonical::{Entry, ToolCall, ToolStatus};
use crate::conversation::{select_records, Discovered};

/// How far past a page's end the pairing scan will look.
///
/// See the module docs: measured p99 is 12 records / 21 KB, so 64 records and
/// 256 KiB leave room for an order-of-magnitude outlier before a call is
/// reported as unknown rather than answered.
pub(crate) const PAIR_SCAN_MAX_RECORDS: usize = 64;
const PAIR_SCAN_MAX_BYTES: u64 = 256 * 1024;

/// How much to read at a time while scanning forward.
const READ_CHUNK: u64 = 32 * 1024;

/// How many records of a page fell into each outcome.
///
/// This replaces a single `skipped` counter, which could not tell "the reader
/// did not understand this" from "the reader understood it and this view does
/// not draw it" — measured, the difference is 25 records out of a median 50.
/// The four counts partition the page, so they add up to [`Self::raw_records`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParseStats {
    /// Every non-empty record the page selected.
    pub raw_records: u64,
    /// Understood, and carrying at least one fact.
    pub recognized_records: u64,
    /// Understood as session state rather than as an event.
    pub metadata_absorbed: u64,
    /// Parsed, but this version has no model for the record's type.
    pub unknown_records: u64,
    /// Not parseable as a JSON object at all.
    pub invalid_records: u64,
}

impl ParseStats {
    fn record(&mut self, outcome: Outcome) {
        self.raw_records += 1;
        match outcome {
            Outcome::Recognized => self.recognized_records += 1,
            Outcome::MetadataAbsorbed => self.metadata_absorbed += 1,
            Outcome::Unknown => self.unknown_records += 1,
            Outcome::Invalid => self.invalid_records += 1,
        }
    }

    /// Records the reader could not model. **Not** the same as "records this page
    /// did not draw**: a record understood as an attachment, a runtime event or
    /// session state is not a failure to read, and counting it as one is what
    /// made a real conversation report that half of itself was missing.
    pub fn unread(&self) -> u64 {
        self.unknown_records + self.invalid_records
    }
}

/// One page of a transcript, canonically.
#[derive(Debug, Clone, Default)]
pub struct CanonicalPage {
    /// Oldest-first within the page, in transcript order.
    pub entries: Vec<Entry>,
    /// Byte offset to pass back to read the page before this one.
    pub next_offset: Option<u64>,
    pub has_more: bool,
    /// The file ended mid-record. Normal for a transcript being appended to.
    pub partial_tail: bool,
    pub stats: ParseStats,
}

/// What a paired result said.
struct ResultFact {
    is_error: bool,
    body: String,
}

/// Read one page of `conversation`, ending at `end_offset`, at most `limit`
/// records wide.
pub fn read_page(
    conversation: &Discovered,
    end_offset: Option<u64>,
    limit: usize,
) -> std::io::Result<CanonicalPage> {
    let mut file = File::open(conversation.path())?;
    let file_len = file.metadata()?.len();
    let end = end_offset.unwrap_or(file_len).min(file_len);
    let selected = select_records(&mut file, file_len, end, limit)?;

    let mut stats = ParseStats::default();
    let mut facts: Vec<Fact> = Vec::new();
    for (offset, line) in &selected.records {
        let adapted = adapt(line, *offset);
        stats.record(adapted.outcome);
        facts.extend(adapted.facts);
    }

    let wanted: HashSet<String> = facts
        .iter()
        .filter_map(|fact| match fact {
            Fact::Call(call) => Some(call.call_id.clone()),
            _ => None,
        })
        .collect();

    // **The page answers its own calls first.** A call and its result are
    // adjacent records, so on the newest page — the one that ends at EOF — every
    // pair is inside the page and the forward scan below finds nothing.
    let mut results: HashMap<String, ResultFact> = HashMap::new();
    for fact in &facts {
        if let Fact::Result(result) = fact {
            results
                .entry(result.call_id.clone())
                .or_insert_with(|| ResultFact {
                    is_error: result.is_error,
                    body: result.body.clone(),
                });
        }
    }

    // Then whatever is left, from beyond the page. `end` is where the page
    // stops, so everything from there on is strictly newer; the scan returns
    // immediately at EOF, which is what makes an in-flight call on the newest
    // page `Running` without a special case.
    //
    // Only the *unanswered* ids are asked for, so a page that resolved
    // everything itself does no I/O at all — and, more importantly, does not
    // report `hit_cap` from a scan that had nothing to find.
    let unresolved: HashSet<String> = wanted
        .iter()
        .filter(|call_id| !results.contains_key(*call_id))
        .cloned()
        .collect();
    let scan = scan_for_results(&mut file, end, file_len, unresolved)?;
    results.extend(scan.results);

    Ok(CanonicalPage {
        entries: materialize(facts, &results, scan.hit_cap),
        next_offset: selected.next_offset,
        has_more: selected.has_more,
        partial_tail: selected.partial_tail,
        stats,
    })
}

/// Turn the page's facts into entries, resolving tool calls.
fn materialize(
    facts: Vec<Fact>,
    results: &HashMap<String, ResultFact>,
    hit_cap: bool,
) -> Vec<Entry> {
    facts
        .into_iter()
        .filter_map(|fact| match fact {
            Fact::Entry(entry) => Some(entry),
            // A result is not an entry: it is what its call produced, and the
            // call carries it.
            Fact::Result(_) => None,
            Fact::Call(call) => Some(Entry::ToolCall(complete(call, results, hit_cap))),
        })
        .collect()
}

/// A pending call as a canonical tool call, with whatever result was found.
fn complete(call: PendingCall, results: &HashMap<String, ResultFact>, hit_cap: bool) -> ToolCall {
    let fact = results.get(&call.call_id);
    let status = match fact {
        Some(fact) if fact.is_error => ToolStatus::Error,
        Some(_) => ToolStatus::Success,
        // No result, and the scan did not stop early: the call is simply the
        // newest thing written.
        None if !hit_cap => ToolStatus::Running,
        // No result, and the scan gave up. Deliberately not `Running` — see the
        // module docs.
        None => ToolStatus::Unknown,
    };

    ToolCall {
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        timestamp: call.timestamp,
        status,
        summary: call.summary,
        input: call.input,
        output: fact.map(|fact| crate::canonical::Payload {
            text: fact.body.clone(),
            is_json: false,
            truncated: false,
        }),
    }
}

/// What the forward scan found, and whether it stopped early.
struct ScanOutcome {
    results: HashMap<String, ResultFact>,
    /// The scan hit a cap with calls still unanswered. The difference between
    /// this and reaching EOF is the difference between `Unknown` and `Running`.
    hit_cap: bool,
}

/// Read forward from `from`, collecting answers to the calls the page named.
///
/// Stops at the first of: every wanted call answered, [`PAIR_SCAN_MAX_RECORDS`]
/// parsed, [`PAIR_SCAN_MAX_BYTES`] read, or the end of the file.
///
/// The lines it reads go through the same [`adapt`] the page did, so the scan
/// knows no Claude field names of its own — a second reader here is exactly the
/// duplication this layer exists to prevent.
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
    let mut carry_offset = from;

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

        // A record is one line, and the tail after the last newline is kept back
        // because it may be a record split across two reads — a half-parsed
        // `tool_result` is worse than none. The same pop handles the clean case:
        // a chunk ending on a newline leaves the empty string after it.
        let mut lines: Vec<&str> = carry.split('\n').collect();
        let tail = lines.pop().unwrap_or("").to_string();

        for line in lines {
            let line_offset = carry_offset;
            carry_offset += line.len() as u64 + 1;
            if line.trim().is_empty() {
                continue;
            }
            parsed += 1;
            collect(line, line_offset, &wanted, &mut results, &mut outstanding);
            // Both caps are checked *inside* the record loop, not after the
            // chunk. A chunk is 32 KiB and can hold hundreds of small records, so
            // a cap tested once per chunk is a cap on how much is read and not on
            // how far the scan looks — it would be exceeded by whatever happened
            // to fit, which is exactly the unboundedness the cap prevents.
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

/// Keep any result in `line` that answers a wanted call.
fn collect(
    line: &str,
    offset: u64,
    wanted: &HashSet<String>,
    results: &mut HashMap<String, ResultFact>,
    outstanding: &mut usize,
) {
    for fact in adapt(line, offset).facts {
        let Fact::Result(result) = fact else {
            continue;
        };
        if !wanted.contains(&result.call_id) || results.contains_key(&result.call_id) {
            continue;
        }
        results.insert(
            result.call_id,
            ResultFact {
                is_error: result.is_error,
                body: result.body,
            },
        );
        *outstanding = outstanding.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::ToolStatus;

    /// One page of a transcript written to a temporary file.
    ///
    /// The directory is dropped when this returns, which is safe because
    /// `read_page` has already read everything it is going to.
    fn page_of(body: &str, end: Option<u64>, limit: usize) -> CanonicalPage {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, body).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");
        read_page(&discovered, end, limit).unwrap()
    }

    fn call(id: &str, body: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"a-{id}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"{id}","name":"Bash","input":{{"command":"{body}"}}}}]}}}}"#
        )
    }

    fn result(id: &str, body: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"u-{id}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{id}","content":"{body}"}}]}}}}"#
        )
    }

    fn tools(page: &CanonicalPage) -> Vec<&ToolCall> {
        page.entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_call_and_its_result_are_one_entry_not_two() {
        // The whole reason pairing is a pass of its own: a result is a record,
        // and a page that rendered each record separately could never say what a
        // tool produced.
        let body = format!("{}\n{}\n", call("t1", "ls"), result("t1", "a.rs"));
        let page = page_of(&body, None, 10);

        assert_eq!(page.entries.len(), 1, "the result became an entry");
        assert_eq!(tools(&page)[0].status, ToolStatus::Success);
        assert_eq!(
            tools(&page)[0].output.as_ref().map(|o| o.text.as_str()),
            Some("a.rs")
        );
    }

    #[test]
    fn the_page_answers_its_own_calls_rather_than_scanning_past_them() {
        // A call and its result are adjacent, so on the newest page every pair is
        // inside it and the forward scan finds nothing. The assertion that can
        // fail: a *later*, different result for the same id must not win — if the
        // scan ran first, or ran at all here, it would overwrite the page's own
        // answer with the newer one beyond the page.
        let adjacent = format!(
            "{}\n{}\n",
            call("t1", "first"),
            result("t1", "the page's own")
        );
        let end = adjacent.len() as u64;
        let later = format!(
            "{}\n{}\n",
            call("t2", "x"),
            result("t1", "a later duplicate")
        );
        let page = page_of(&format!("{adjacent}{later}"), Some(end), 10);

        assert_eq!(tools(&page)[0].status, ToolStatus::Success);
        assert_eq!(
            tools(&page)[0].output.as_ref().map(|o| o.text.as_str()),
            Some("the page's own"),
            "the page's own answer was overwritten by one from beyond it"
        );
    }

    #[test]
    fn a_call_with_nothing_after_it_is_running_rather_than_unknown() {
        // At EOF there is nothing newer to look at, so "no result" means "not
        // written yet". `Unknown` would be the provider claiming it gave up.
        let page = page_of(&format!("{}\n", call("t1", "sleep 1")), None, 10);
        assert_eq!(tools(&page)[0].status, ToolStatus::Running);
    }

    #[test]
    fn an_orphan_result_is_not_an_entry() {
        // A result whose call is on an older page is not this page's business,
        // and rendering it would put a tool with no call in the transcript.
        let page = page_of(&format!("{}\n", result("t-absent", "orphan")), None, 10);
        assert!(page.entries.is_empty(), "{:?}", page.entries);
    }

    #[test]
    fn the_stats_partition_the_page() {
        // The requirement this exists for: a reader must be able to tell "I did
        // not understand this record" from "I understood it and this view does
        // not draw it". Four counts, one per outcome, and they add up — which is
        // what makes `raw_records` a check on the accounting rather than a second
        // opinion.
        let body = concat!(
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"a title"}"#,
            "\n",
            r#"{"type":"brand-new-record-type","uuid":"x"}"#,
            "\n",
            "not json at all\n",
        );
        let page = page_of(body, None, 10);

        assert_eq!(
            page.stats,
            ParseStats {
                raw_records: 4,
                recognized_records: 1,
                metadata_absorbed: 1,
                unknown_records: 1,
                invalid_records: 1,
            }
        );
        assert_eq!(
            page.stats.raw_records,
            page.stats.recognized_records
                + page.stats.metadata_absorbed
                + page.stats.unknown_records
                + page.stats.invalid_records
        );
    }

    #[test]
    fn unread_counts_only_what_could_not_be_modelled() {
        // The number the conversation shows. Session state and a paired result
        // are both understood, and counting either would make an ordinary page
        // report that most of itself was missing — measured, the median page
        // carries 25 such records out of 50.
        let body = concat!(
            r#"{"type":"ai-title","aiTitle":"a title"}"#,
            "\n",
            r#"{"type":"brand-new-record-type","uuid":"x"}"#,
            "\n",
        );
        let page = page_of(body, None, 10);

        assert_eq!(page.stats.metadata_absorbed, 1);
        assert_eq!(
            page.stats.unread(),
            1,
            "session state was counted as a record the reader could not read"
        );
    }

    #[test]
    fn a_record_without_a_uuid_still_gets_a_distinct_identity() {
        // Two session-state records in one page must not collide on an empty id.
        // Measured, 129,829 records carry no uuid, and every one of them used to
        // normalize to the same empty string.
        let body = concat!(
            r#"{"type":"ai-title","aiTitle":"one"}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"two"}"#,
            "\n",
        );
        let page = page_of(body, None, 10);

        let ids: Vec<&str> = page.entries.iter().map(Entry::id).collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "two records shared one identity: {ids:?}");
    }

    #[test]
    fn a_page_reports_where_the_next_one_starts() {
        let body = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"user","uuid":"m1","message":{"role":"user","content":"one"}}"#,
            r#"{"type":"user","uuid":"m2","message":{"role":"user","content":"two"}}"#,
            r#"{"type":"user","uuid":"m3","message":{"role":"user","content":"three"}}"#,
        );
        let page = page_of(&body, None, 2);

        assert!(page.has_more);
        assert!(page.next_offset.is_some());
        assert_eq!(page.entries.len(), 2, "the newest two records");

        // And walking back reaches the rest, exactly once.
        let older = page_of(&body, page.next_offset, 2);
        assert!(!older.has_more);
        assert_eq!(older.entries.len(), 1);
    }

    #[test]
    fn a_partial_trailing_record_is_reported_and_the_finished_ones_still_read() {
        let body = format!(
            "{}\n{}\n{{\"type\":\"user\",\"uuid\":\"x\",\"mess",
            r#"{"type":"user","uuid":"m1","message":{"role":"user","content":"one"}}"#,
            r#"{"type":"user","uuid":"m2","message":{"role":"user","content":"two"}}"#,
        );
        let page = page_of(&body, None, 10);

        assert_eq!(page.entries.len(), 2);
        assert!(
            page.partial_tail,
            "a half-written last line must be reported"
        );
    }

    #[test]
    fn a_message_records_source_survives_into_the_page() {
        // The projection is where the decision to draw or hide is made, so the
        // fact it decides on has to arrive intact.
        let body = concat!(
            r#"{"type":"user","uuid":"u1","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"injected"}]}}"#,
            "\n",
        );
        let page = page_of(body, None, 10);

        let [Entry::Message(message)] = page.entries.as_slice() else {
            panic!("expected one message, got {:?}", page.entries);
        };
        assert_eq!(message.source, crate::canonical::MessageSource::Synthetic);
    }
}
