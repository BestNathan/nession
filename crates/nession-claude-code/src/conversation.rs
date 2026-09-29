//! Finding a Session's conversations on disk (#1005).
//!
//! Two jobs, both of which exist to keep Claude Code's file format inside this
//! crate:
//!
//! 1. **Discovery** — which transcripts belong to a given working directory.
//! 2. **Page selection** — which records of one transcript a page contains.
//!
//! Turning those records into conversation items is [`crate::messages`]' job;
//! the retired v1 normalization that used to live here was removed with the
//! `claude-code.conversation` unit it served (#1222), and what survives is the
//! half the two remaining units share.
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

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[cfg(test)]
use std::cell::RefCell;

use serde_json::Value;

/// Claude's record types that carry conversation.
const MESSAGE_TYPES: [&str; 2] = ["user", "assistant"];

/// Whether a record type is one that carries conversation.
///
/// Shared with [`crate::messages`], which asks the same question of the same
/// open set: a type that is not a message is bookkeeping, and bookkeeping must
/// not become a chat row.
pub(crate) fn is_message_record(kind: &str) -> bool {
    MESSAGE_TYPES.contains(&kind)
}

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
    /// Claude's own title for this conversation, when it wrote one.
    ///
    /// Read from the transcript's **last** `ai-title` record rather than its
    /// first, because the title is rewritten as the conversation evolves:
    /// measured, one transcript held 1337 of them and started at `"Stage 1b"`
    /// while ending at `"app-sessions-redesign"`. The last one is the current
    /// one.
    ///
    /// **Display metadata, never identity.** Two conversations may carry the
    /// same title, and none of the selection paths read this — they all use
    /// `claude_session_id`, as they did before this field existed.
    pub title: Option<String>,
    /// The last thing the user asked, when Claude recorded it (#1120 item 5).
    ///
    /// A list row needs a second line — a title alone says what a conversation
    /// is *called*, not where it got to — and the honest answer is the prompt
    /// the user last typed. Read from the transcript's **last** `last-prompt`
    /// record for the same reason the title is: measured, it is rewritten as
    /// the conversation evolves.
    ///
    /// Not necessarily prose. Measured over real transcripts it is often a
    /// slash command invocation (`/nession-writing-requirements …`), which is
    /// still the truth about the conversation and is passed through rather than
    /// filtered. Measured length: min 1, median 25, p90 143, max 201 characters,
    /// so a caller rendering a single line must collapse whitespace and bound
    /// it — and must survive a one-character value without looking broken.
    ///
    /// **Display metadata, never identity**, exactly as `title` is.
    pub preview: Option<String>,
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
    #[cfg(test)]
    if let Some(root) = PROJECTS_ROOT.with(|cell| cell.borrow().clone()) {
        return Some(root);
    }
    crate::security::claude_home_dir().map(|home| home.join("projects"))
}

#[cfg(test)]
thread_local! {
    /// Where discovery looks, for the current test thread.
    ///
    /// Thread-local rather than an environment variable, and that is the whole
    /// point: `HOME` is process-wide, so a test that set it would change the
    /// answer for every other test running beside it in the same binary — and
    /// the symptom would be *those* tests failing, seemingly at random.
    static PROJECTS_ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Points discovery at a temporary tree for as long as it is alive.
///
/// Exists because discovery is otherwise unreachable from a test: it reads
/// `~/.claude/projects`, and the tests are not allowed to write into the
/// developer's real one. Without this the only reachable `cwd` is one with no
/// conversations, so "resolves to the right conversation" could not be asserted
/// at all.
#[cfg(test)]
pub(crate) struct ProjectsRootForTest(Option<PathBuf>);

#[cfg(test)]
impl ProjectsRootForTest {
    pub(crate) fn set(root: PathBuf) -> Self {
        PROJECTS_ROOT.with(|cell| Self(cell.replace(Some(root))))
    }
}

#[cfg(test)]
impl Drop for ProjectsRootForTest {
    fn drop(&mut self) {
        let previous = self.0.take();
        PROJECTS_ROOT.with(|cell| {
            cell.replace(previous);
        });
    }
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

    let tail = tail_facts(path);

    Some(Discovered {
        claude_session_id,
        cwd: recorded_cwd,
        updated_at: tail.updated_at,
        title: tail.title,
        preview: tail.preview,
        path: path.to_path_buf(),
    })
}

/// What a transcript's last chunk says about it.
///
/// All three questions are *last-record* questions — the newest timestamp, the
/// current title and the last prompt are at the end of a transcript, not the
/// start — so one read answers all three. Measured over 14 real transcripts:
/// the last 64 KiB yields a title for exactly the 11 that carry one anywhere.
/// Measured again over 120 for the prompt (#1120 item 5): it yields one for 106,
/// and **all 14 of the rest have no `last-prompt` anywhere in the file** —
/// checked by scanning each whole, not inferred — and they are uniformly small
/// (2.3 KB–66 KB, mostly ≈20 KB), short conversations that never had the record
/// written. So the bound that already existed for `updated_at` is sufficient
/// for all three and costs **no extra I/O**. Widening it would not find more; it
/// would only read more.
#[derive(Default)]
struct TailFacts {
    updated_at: Option<String>,
    title: Option<String>,
    preview: Option<String>,
}

fn tail_facts(path: &Path) -> TailFacts {
    let Ok(mut file) = File::open(path) else {
        return TailFacts::default();
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return TailFacts::default();
    };
    if file
        .seek(SeekFrom::Start(len.saturating_sub(READ_CHUNK)))
        .is_err()
    {
        return TailFacts::default();
    }
    let mut tail = String::new();
    if file.read_to_string(&mut tail).is_err() {
        return TailFacts::default();
    }

    let mut facts = TailFacts::default();
    for line in tail.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            // The window starts mid-record, and a transcript being appended to
            // ends mid-record. Both are expected.
            continue;
        };
        // Last wins for all three, which is the whole reason this reads the tail.
        if let Some(timestamp) = string_field(&record, "timestamp") {
            facts.updated_at = Some(timestamp);
        }
        if record.get("type").and_then(Value::as_str) == Some("ai-title") {
            // The measured shape is `{"type":"ai-title","aiTitle":"…"}`. An
            // empty title is treated as absent: it says nothing a row can show,
            // and letting it through would replace a usable fallback with a
            // blank.
            match string_field(&record, "aiTitle") {
                Some(title) if !title.trim().is_empty() => facts.title = Some(title),
                _ => {}
            }
        }
        if record.get("type").and_then(Value::as_str) == Some("last-prompt") {
            // The measured shape is
            // `{"type":"last-prompt","lastPrompt":"…","leafUuid":"…"}`.
            //
            // The field is **optional on its own record** — measured, 139 of
            // 7501 `last-prompt` records carried no `lastPrompt` at all, and the
            // samples without one sit at the start of a session. So a record
            // missing the field is skipped rather than treated as clearing it:
            // absence here means "not written yet", not "the user said nothing",
            // and a blank preview would replace a usable one for no reason. Same
            // rule as the title's, and the same reason.
            match string_field(&record, "lastPrompt") {
                Some(prompt) if !prompt.trim().is_empty() => facts.preview = Some(prompt),
                _ => {}
            }
        }
    }
    facts
}

/// The raw records of one page, before any of them is interpreted.
///
/// *Which* records a page contains is a property of the transcript and the
/// cursor, not of the shape a reader renders them as — which is why selection
/// lives here and interpretation lives in [`crate::messages`].
pub(crate) struct Selected {
    /// Oldest-first within the page, each with the byte offset it starts at.
    pub(crate) records: Vec<(u64, String)>,
    /// Byte offset to pass back to read the page before this one.
    pub(crate) next_offset: Option<u64>,
    pub(crate) has_more: bool,
    /// The file ended mid-record. Normal for a transcript being appended to.
    pub(crate) partial_tail: bool,
}

/// Choose the `limit` newest records ending at `end`, reading backwards.
///
/// The byte offsets are what make the cursor exact: a page boundary that landed
/// mid-record would show one item twice, or lose it between pages. They are also
/// what [`crate::messages`] scans forward from when it pairs a tool call with a
/// result that landed on the next page.
pub(crate) fn select_records(
    file: &mut File,
    file_len: u64,
    end: u64,
    limit: usize,
) -> std::io::Result<Selected> {
    // Records newest-first, each with the byte offset it starts at.
    let mut records: Vec<(u64, String)> = Vec::new();
    let mut cursor = end;
    let mut partial_tail = false;
    let mut first_chunk = true;

    while cursor > 0 && records.len() <= limit {
        // Begin every chunk at a record boundary, so a record is never split
        // across two reads and each line's offset is computable.
        let start = align_to_record(file, cursor.saturating_sub(READ_CHUNK))?;
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
    let mut page_records: Vec<(u64, String)> = records.drain(..take).collect();
    page_records.reverse();

    // Continue from the oldest record this page showed; everything before it is
    // strictly older and cannot repeat a row. Read off the page itself, before
    // it is handed over, because it is the one fact a caller cannot recompute
    // from the records alone.
    let next_offset = if records.is_empty() {
        None
    } else {
        page_records.first().map(|(offset, _)| *offset)
    };
    let has_more = !records.is_empty();

    Ok(Selected {
        records: page_records,
        next_offset,
        has_more,
        partial_tail,
    })
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

/// A string field, when the record carries one.
pub(crate) fn string_field(record: &Value, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Handles for tests in sibling modules.
///
/// `Discovered`'s transcript path is private to this module — that privacy is
/// the mechanism keeping a path off the wire — so a sibling that wants to read a
/// *specific* file has to be handed one from here rather than assembling the
/// struct itself.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::{Discovered, Path};

    /// A `Discovered` pointing at `path`, without running discovery.
    pub(crate) fn discovered_at(path: &Path, cwd: &str) -> Discovered {
        Discovered {
            claude_session_id: "test-session".to_string(),
            cwd: cwd.to_string(),
            updated_at: None,
            title: None,
            preview: None,
            path: path.to_path_buf(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- discovery ------------------------------------------------------

    /// A transcript in the shape `inspect` reads: a `cwd` it can find.
    fn transcript_at(dir: &Path, name: &str, cwd: &str, last: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(
            &path,
            format!(
                r#"{{"type":"user","uuid":"u","timestamp":"{last}","cwd":"{cwd}","sessionId":"{name}","message":{{"role":"user","content":"hi"}}}}"#
            ),
        )
        .expect("write the transcript");
        path
    }

    #[test]
    fn discovery_finds_only_the_transcripts_recorded_at_that_cwd() {
        // Untested until now, and it is the step every conversation answer
        // stands on: the whole candidate list comes from here. The two ways to
        // get it wrong are opposite — matching the *directory name* instead of
        // the recorded cwd (which is why transcripts in one project folder can
        // belong to different directories), and matching too loosely.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_at(&project, "mine.jsonl", "/w", "2026-09-25T00:00:09Z");
        transcript_at(
            &project,
            "other.jsonl",
            "/somewhere-else",
            "2026-09-25T00:00:01Z",
        );
        // Not a transcript at all, and must not become a candidate.
        std::fs::write(project.join("notes.txt"), "hello").unwrap();

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1, "only the cwd's own transcript: {found:?}");
        assert_eq!(found[0].claude_session_id, "mine.jsonl");
    }

    #[test]
    fn discovery_lists_newest_first_and_puts_undated_last() {
        // The order is a *listing* order, not a selection (#1005 decision 3) —
        // but it is what the user chooses from, so it has to be the useful one.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_at(&project, "older.jsonl", "/w", "2026-09-25T00:00:01Z");
        transcript_at(&project, "newer.jsonl", "/w", "2026-09-25T00:00:09Z");
        // A real candidate — it has a session id and the right cwd — that
        // simply carries no timestamp. Nothing to date it by, so it is not
        // evidence of recency and goes last rather than first.
        std::fs::write(
            project.join("undated.jsonl"),
            r#"{"type":"user","uuid":"u","cwd":"/w","sessionId":"undated.jsonl","message":{"role":"user","content":"hi"}}"#,
        )
        .unwrap();

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let ids: Vec<String> = conversations_at("/w")
            .into_iter()
            .map(|c| c.claude_session_id)
            .collect();

        assert_eq!(ids, vec!["newer.jsonl", "older.jsonl", "undated.jsonl"]);
    }

    #[test]
    fn a_projects_root_that_is_not_there_yields_no_candidates() {
        // Read at startup and after a Claude config change; a missing tree is an
        // ordinary state, not a failure to report.
        let root = tempfile::tempdir().unwrap();
        let absent = root.path().join("never-created");
        let _root = ProjectsRootForTest::set(absent);

        assert!(conversations_at("/w").is_empty());
    }

    // ---- titles ---------------------------------------------------------

    /// A transcript carrying `ai-title` records, in the order given.
    fn transcript_with_titles(dir: &Path, name: &str, cwd: &str, titles: &[&str]) -> PathBuf {
        let mut body = format!(
            r#"{{"type":"user","uuid":"u","timestamp":"2026-09-25T00:00:09Z","cwd":"{cwd}","sessionId":"{name}","message":{{"role":"user","content":"hi"}}}}"#
        );
        for title in titles {
            body.push('\n');
            body.push_str(&format!(
                r#"{{"type":"ai-title","aiTitle":"{title}","sessionId":"{name}"}}"#
            ));
        }
        body.push('\n');
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write the transcript");
        path
    }

    #[test]
    fn the_title_is_the_last_ai_title_record_not_the_first() {
        // Measured against a real transcript: it held 1337 of them, opening at
        // "Stage 1b" and ending at "app-sessions-redesign". The title is
        // rewritten as the conversation evolves, so the first record is what
        // Claude called the conversation in its opening seconds — reading it
        // would label every row by a name the work has since outgrown.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_with_titles(
            &project,
            "mine.jsonl",
            "/w",
            &["Stage 1b", "app-sessions-redesign"],
        );

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title.as_deref(), Some("app-sessions-redesign"));
    }

    #[test]
    fn a_transcript_with_no_title_reports_none_rather_than_inventing_one() {
        // Measured: 3 of 14 sampled transcripts carry no `ai-title` at all, so
        // absence is an ordinary state and not a failure. Substituting anything
        // here would make "no title" indistinguishable from a title, and would
        // take the choice of fallback away from the client that has to draw it.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_at(&project, "mine.jsonl", "/w", "2026-09-25T00:00:09Z");

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, None);
    }

    #[test]
    fn an_empty_title_is_treated_as_absent() {
        // An empty string is not a title a row can show. Letting it through
        // would replace whatever the client would otherwise draw with a blank
        // line, which reads as a bug rather than as "Claude named nothing".
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_with_titles(&project, "mine.jsonl", "/w", &[""]);

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, None);
    }

    // ---- previews -------------------------------------------------------

    /// A transcript carrying `last-prompt` records, in the order given.
    fn transcript_with_prompts(dir: &Path, name: &str, cwd: &str, prompts: &[&str]) -> PathBuf {
        let mut body = format!(
            r#"{{"type":"user","uuid":"u","timestamp":"2026-09-25T00:00:09Z","cwd":"{cwd}","sessionId":"{name}","message":{{"role":"user","content":"hi"}}}}"#
        );
        for prompt in prompts {
            body.push('\n');
            body.push_str(&format!(
                r#"{{"type":"last-prompt","lastPrompt":"{prompt}","leafUuid":"l","sessionId":"{name}"}}"#
            ));
        }
        body.push('\n');
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write the transcript");
        path
    }

    #[test]
    fn the_preview_is_the_last_last_prompt_record_not_the_first() {
        // Same shape as the title, and for the same measured reason: the record
        // is rewritten as the conversation evolves (7501 of them across a
        // 30-transcript sample). A row showing the *first* prompt would describe
        // where every conversation started rather than where it got to, which is
        // the one thing the second line of the row exists to say.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_with_prompts(
            &project,
            "mine.jsonl",
            "/w",
            &["start on the capsule", "now do the transcript"],
        );

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].preview.as_deref(), Some("now do the transcript"));
    }

    #[test]
    fn a_transcript_with_no_last_prompt_reports_none_rather_than_inventing_one() {
        // Measured: 14 of 120 transcripts carry no `last-prompt` anywhere, and
        // all 14 are small ones (2.3 KB–66 KB) that never had the record
        // written. Absence is an ordinary state, so the row must degrade to
        // title and time — substituting the first user message here would put
        // text in the list that the transcript never offered as a summary.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_at(&project, "mine.jsonl", "/w", "2026-09-25T00:00:09Z");

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].preview, None);
    }

    #[test]
    fn a_last_prompt_record_without_the_field_does_not_clear_an_earlier_preview() {
        // The measured quirk this rule exists for: **139 of 7501** `last-prompt`
        // records carried no `lastPrompt` at all, so the field is optional on its
        // own record and can be missing from the newest one.
        //
        // Absence there means "not written", not "the user said nothing", so it
        // is skipped rather than treated as clearing — the last record **that
        // carries a value** wins. Clearing would trade a true, useful line for a
        // blank one on the strength of a field the provider never had. This is
        // the same rule the title uses, and the assertion that can fail if the
        // implementation ever starts reading "the last record" instead of "the
        // last value".
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();

        let body = concat!(
            r#"{"type":"user","uuid":"u","timestamp":"2026-09-25T00:00:09Z","cwd":"/w","sessionId":"mine.jsonl","message":{"role":"user","content":"hi"}}"#,
            "\n",
            r#"{"type":"last-prompt","lastPrompt":"the real last thing","leafUuid":"a","sessionId":"mine.jsonl"}"#,
            "\n",
            r#"{"type":"last-prompt","leafUuid":"b","sessionId":"mine.jsonl"}"#,
            "\n",
        );
        std::fs::write(project.join("mine.jsonl"), body).expect("write the transcript");

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].preview.as_deref(), Some("the real last thing"));
    }

    #[test]
    fn an_empty_prompt_is_treated_as_absent() {
        // An empty string is not a preview a row can show, and letting it
        // through would replace a usable line with a blank one. Same rule as the
        // empty title, for the same reason.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_with_prompts(&project, "mine.jsonl", "/w", &[""]);

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].preview, None);
    }

    #[test]
    fn the_preview_is_the_users_own_text_and_is_not_reformatted() {
        // Measured, the prompt is frequently a slash-command invocation, and it
        // can be one character long. Both are passed through rather than
        // filtered or reshaped: this field reports what the user typed, and a
        // provider that decided which prompts were "real" would be making a
        // product judgement the contract has no business making. Bounding it for
        // display belongs to the caller, which is the only layer that knows the
        // row's width.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();
        transcript_with_prompts(
            &project,
            "mine.jsonl",
            "/w",
            &["/nession-web-design 收敛设计"],
        );

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].preview.as_deref(),
            Some("/nession-web-design 收敛设计")
        );
    }

    #[test]
    fn the_title_is_found_when_the_transcript_is_larger_than_the_read_window() {
        // The title is read from a bounded tail window, so the case that would
        // break it is a transcript whose `ai-title` sits behind that window.
        // Measured over real transcripts the window was always enough (the last
        // 64 KiB yielded a title for exactly the transcripts that have one) —
        // this pins the behaviour so a later change to the window has to
        // confront it rather than silently report absence.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-w");
        std::fs::create_dir_all(&project).unwrap();

        let mut body = String::from(
            r#"{"type":"user","uuid":"u","timestamp":"2026-09-25T00:00:09Z","cwd":"/w","sessionId":"mine.jsonl","message":{"role":"user","content":"hi"}}"#,
        );
        for n in 0..2_000 {
            body.push('\n');
            body.push_str(&format!(
                r#"{{"type":"user","uuid":"f{n}","timestamp":"2026-09-25T00:01:00Z","cwd":"/w","sessionId":"mine.jsonl","message":{{"role":"user","content":"filler {n}"}}}}"#
            ));
        }
        body.push('\n');
        body.push_str(r#"{"type":"ai-title","aiTitle":"at the tail","sessionId":"mine.jsonl"}"#);
        body.push('\n');
        std::fs::write(project.join("mine.jsonl"), body).expect("write the transcript");

        let _root = ProjectsRootForTest::set(root.path().to_path_buf());
        let found = conversations_at("/w");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title.as_deref(), Some("at the tail"));
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
            // Built directly rather than through `inspect`, so there is no tail
            // to read display metadata from. The title and preview paths have
            // their own tests.
            title: None,
            preview: None,
            path,
        }
    }

    /// Select one page of raw records, the way [`crate::messages`] does before
    /// it interprets them.
    fn select(conversation: &Discovered, end_offset: Option<u64>, limit: usize) -> Selected {
        let mut file = File::open(conversation.path()).expect("open the transcript");
        let file_len = file.metadata().expect("the transcript's metadata").len();
        let end = end_offset.unwrap_or(file_len).min(file_len);
        select_records(&mut file, file_len, end, limit).expect("select a page")
    }

    /// The user-turn texts of a page's records, in page order.
    fn texts_of(selected: &Selected) -> Vec<String> {
        selected
            .records
            .iter()
            .filter_map(|(_, line)| {
                let record = serde_json::from_str::<Value>(line).ok()?;
                record
                    .pointer("/message/content")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect()
    }

    /// Walk every page backwards, newest first, and return the texts in
    /// conversation order.
    fn page_through(conversation: &Discovered, page_size: usize) -> Vec<String> {
        let mut pages = Vec::new();
        let mut offset = None;
        loop {
            let page = select(conversation, offset, page_size);
            pages.push(texts_of(&page));
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

        let page = select(&conversation, None, 3);
        assert_eq!(
            texts_of(&page),
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

        let page = select(&conversation, None, 10);
        assert_eq!(texts_of(&page), vec!["message 0", "message 1"]);
        assert!(
            page.partial_tail,
            "a half-written last line must be reported, not silently ignored"
        );
    }

    #[test]
    fn a_cleanly_terminated_transcript_is_not_reported_as_partial() {
        let dir = tempfile::tempdir().unwrap();
        let conversation = transcript(dir.path(), &format!("{}\n", turn(0)));
        let page = select(&conversation, None, 10);
        assert!(!page.partial_tail);
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
