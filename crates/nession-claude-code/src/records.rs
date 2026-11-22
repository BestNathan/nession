//! Raw transcript record access (`#3726`, `#4027`).
//!
//! Discovery and page selection already live in [`crate::conversation`]. This
//! module is the access layer the Transcript surface reads through: it selects
//! a page of physical JSONL lines without interpreting them, applies the raw
//! page budgets, and resolves one record in bounded chunks.
//!
//! ## Why an identity is a content fingerprint
//!
//! A byte offset is only meaningful against the bytes it was computed from.
//! Transcripts are append-only in normal operation, so an offset stays valid
//! while the file grows — but a resumed session that rewrites a transcript in
//! place would silently turn an old offset into different bytes. A reference or
//! cursor therefore carries a fingerprint of the bytes it names, not of the
//! file's first line: a rewrite that preserves the first line but changes a
//! later record still changes the bytes under that identity (`#4027`).
//!
//! - A **record reference** binds its own line's bytes. Appending records never
//!   touches them, so the reference stays valid across growth, while changing
//!   that line makes it stale.
//! - A **cursor** binds the byte range of the page it was issued with. Appends
//!   land after that range, so older pages keep working; rewriting any record
//!   the caller already saw inside it makes the cursor stale.
//!
//! ## Why a reference is hex, not a file path
//!
//! The reference is opaque on purpose: it carries the transcript identity and
//! the offset, never a path. The handler resolves the identity against the
//! Session's authorized transcript list before opening anything, so a client
//! cannot point this at an arbitrary file by editing a string.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use crate::conversation::{select_records, Discovered, SelectedRecord};
use crate::fingerprint;
use crate::protocol::transcript_record::v1::CHUNK_CEILING;
use crate::protocol::transcript_records::v1::{PAGE_INLINE_BUDGET, RECORD_INLINE_CEILING};

/// Prefix identifying this reference format.
///
/// Bumped from `tr1` when references started binding their own content
/// (`#4027`): a `tr1` reference only vouched for the file's first line, so it
/// cannot be upgraded into the stronger identity — it is refused instead.
const REF_PREFIX: &str = "tr2";

/// How much to read at a time while locating a line's end or hashing a range.
const SCAN_CHUNK: usize = 64 * 1024;

/// One page of raw records.
#[derive(Debug, Clone, Default)]
pub(crate) struct RawPage {
    /// Oldest-first, one per non-empty physical line.
    pub(crate) records: Vec<RawRecord>,
    /// Continuation to the page before this one, when one exists.
    pub(crate) next_cursor: Option<Cursor>,
    pub(crate) has_more: bool,
    pub(crate) partial_tail: bool,
}

/// One raw record, with its original line when the page could carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawRecord {
    pub(crate) offset: u64,
    pub(crate) size_bytes: u64,
    /// The original line text, or `None` when it exceeded the inline bounds.
    pub(crate) raw: Option<String>,
    /// Fingerprint of the line's original bytes.
    pub(crate) fingerprint: u64,
}

/// The result of resolving one record reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecordRead {
    /// A bounded chunk of the line.
    Ready {
        raw: String,
        /// Byte offset within the line where this chunk starts.
        offset: u64,
        /// The line's total length in bytes.
        size_bytes: u64,
        /// Whether more of the line exists after this chunk.
        has_more: bool,
        /// Byte offset within the line where the next chunk starts.
        next_offset: u64,
    },
    /// The reference was issued against different bytes.
    StaleGeneration,
    /// The reference does not locate a record in this transcript.
    NotFound,
}

/// A decoded single-record reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordRef {
    pub(crate) transcript_id: String,
    pub(crate) offset: u64,
    /// Fingerprint of the line's original bytes.
    pub(crate) fingerprint: u64,
}

/// A decoded page continuation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Cursor {
    pub(crate) transcript_id: String,
    /// Byte offset the page before this one ends at.
    pub(crate) end: u64,
    /// End of the byte range this cursor vouches for: the issuing page's end.
    ///
    /// Appended bytes land at or after this offset and so leave the cursor
    /// valid; rewriting a record the issuing page showed changes the range.
    pub(crate) span_end: u64,
    /// Fingerprint over `[end, span_end)`.
    pub(crate) fingerprint: u64,
}

/// An opaque resource-scoped identity this provider issues.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reference {
    Record(RecordRef),
    Cursor(Cursor),
}

/// Encode a reference to one raw record.
pub(crate) fn encode_record_ref(transcript_id: &str, offset: u64, fingerprint: u64) -> String {
    format!(
        "{REF_PREFIX}:{}:r:{offset:x}:{fingerprint:016x}",
        hex_encode(transcript_id.as_bytes())
    )
}

/// Encode a reference to the page before `cursor`.
pub(crate) fn encode_cursor(cursor: &Cursor) -> String {
    format!(
        "{REF_PREFIX}:{}:c:{:x}:{:x}:{:016x}",
        hex_encode(cursor.transcript_id.as_bytes()),
        cursor.end,
        cursor.span_end,
        cursor.fingerprint
    )
}

/// Decode a reference, returning `None` for anything this version did not issue.
pub(crate) fn decode_ref(raw: &str) -> Option<Reference> {
    let mut parts = raw.split(':');
    if parts.next()? != REF_PREFIX {
        return None;
    }
    let transcript_id = String::from_utf8(hex_decode(parts.next()?)?).ok()?;
    match parts.next()? {
        "r" => {
            let offset = u64::from_str_radix(parts.next()?, 16).ok()?;
            let fingerprint = u64::from_str_radix(parts.next()?, 16).ok()?;
            if parts.next().is_some() {
                return None;
            }
            Some(Reference::Record(RecordRef {
                transcript_id,
                offset,
                fingerprint,
            }))
        }
        "c" => {
            let end = u64::from_str_radix(parts.next()?, 16).ok()?;
            let span_end = u64::from_str_radix(parts.next()?, 16).ok()?;
            let fingerprint = u64::from_str_radix(parts.next()?, 16).ok()?;
            if parts.next().is_some() || span_end < end {
                return None;
            }
            Some(Reference::Cursor(Cursor {
                transcript_id,
                end,
                span_end,
                fingerprint,
            }))
        }
        _ => None,
    }
}

/// Read one page of the transcript as raw lines.
pub(crate) fn read_page(
    conversation: &Discovered,
    cursor: Option<&Cursor>,
    limit: usize,
) -> io::Result<RawPage> {
    let mut file = File::open(conversation.path())?;
    let file_len = file.metadata()?.len();

    // Every cursor failure is `InvalidInput`, which the handler reports as
    // `stale_cursor`. Checking here, before selection, keeps a stale offset
    // from being applied to bytes it was not computed against.
    let end = match cursor {
        None => file_len,
        Some(cursor) => {
            if cursor.end > file_len || cursor.span_end > file_len {
                return Err(stale_cursor());
            }
            // A cursor names a record boundary. A forged or damaged offset
            // inside a line would silently drop that line and page from the
            // middle of it.
            if cursor.end > 0 && cursor.end < file_len {
                file.seek(SeekFrom::Start(cursor.end - 1))?;
                let mut previous = [0u8; 1];
                file.read_exact(&mut previous)?;
                if previous[0] != b'\n' {
                    return Err(stale_cursor());
                }
            }
            // The range a cursor vouches for is the page it was issued with.
            // Appending after that page leaves it untouched; rewriting any
            // record the caller already saw changes it.
            if fingerprint_range(&mut file, cursor.end, cursor.span_end)? != cursor.fingerprint {
                return Err(stale_cursor());
            }
            cursor.end
        }
    };

    let selected = select_records(&mut file, file_len, end, limit)?;

    let mut budget = PAGE_INLINE_BUDGET;
    let records = selected
        .records
        .into_iter()
        .map(|record| {
            let SelectedRecord {
                offset,
                size_bytes,
                line,
                fingerprint,
            } = record;
            let size = usize::try_from(size_bytes).unwrap_or(usize::MAX);
            let raw = if size <= RECORD_INLINE_CEILING && size <= budget {
                budget -= size;
                Some(line)
            } else {
                None
            };
            RawRecord {
                offset,
                size_bytes,
                raw,
                fingerprint,
            }
        })
        .collect();

    let next_cursor = match selected.next_offset {
        Some(start) => Some(Cursor {
            transcript_id: conversation.claude_session_id.clone(),
            end: start,
            span_end: end,
            fingerprint: fingerprint_range(&mut file, start, end)?,
        }),
        None => None,
    };

    // If the file changed while the page was being selected, the bytes describe
    // one file and the identity another. Returning either would be a claim the
    // provider cannot support; the caller can re-read.
    if file.metadata()?.len() != file_len {
        return Err(io::Error::other(
            "the transcript changed while the page was being read",
        ));
    }

    Ok(RawPage {
        records,
        next_cursor,
        has_more: selected.has_more,
        partial_tail: selected.partial_tail,
    })
}

/// Resolve one record reference to a bounded chunk of its line.
pub(crate) fn read_record(
    conversation: &Discovered,
    expected_fingerprint: u64,
    line_offset: u64,
    chunk_offset: u64,
    chunk_limit: u32,
) -> io::Result<RecordRead> {
    let mut file = File::open(conversation.path())?;
    let file_len = file.metadata()?.len();

    // A reference names a record only if it starts at the beginning of a
    // line. Checking the byte before it makes a forged offset fail closed
    // instead of slicing arbitrary bytes out of the transcript.
    if line_offset >= file_len {
        return Ok(RecordRead::NotFound);
    }
    if line_offset > 0 {
        file.seek(SeekFrom::Start(line_offset - 1))?;
        let mut previous = [0u8; 1];
        file.read_exact(&mut previous)?;
        if previous[0] != b'\n' {
            return Ok(RecordRead::NotFound);
        }
    }

    // The reference names these bytes. A rewrite that kept the file's first
    // line — or replaced the file wholesale — changes them, and the reference
    // must not resolve to the new content (`#4027`).
    let (line_end, fingerprint) = scan_line(&mut file, line_offset, file_len)?;
    if fingerprint != expected_fingerprint {
        return Ok(RecordRead::StaleGeneration);
    }

    let size_bytes = line_end - line_offset;
    let relative = adjust_start(&mut file, line_offset, chunk_offset.min(size_bytes))?;
    let wanted = u64::from(chunk_limit.clamp(1, CHUNK_CEILING)).min(size_bytes - relative);

    let mut bytes = vec![
        0u8;
        usize::try_from(wanted).map_err(|_| io::Error::new(
            io::ErrorKind::InvalidData,
            "record chunk too large",
        ))?
    ];
    file.seek(SeekFrom::Start(line_offset + relative))?;
    file.read_exact(&mut bytes)?;

    let has_more = relative + wanted < size_bytes;
    if has_more {
        bytes.truncate(floor_char_boundary(&bytes));
    }

    // A replacement after the first check but before this read must not be
    // returned as if it were the record the reference named.
    if fingerprint_range(&mut file, line_offset, line_end)? != expected_fingerprint {
        return Ok(RecordRead::StaleGeneration);
    }

    let next_offset = relative + bytes.len() as u64;
    Ok(RecordRead::Ready {
        raw: String::from_utf8_lossy(&bytes).into_owned(),
        offset: relative,
        size_bytes,
        has_more: next_offset < size_bytes,
        next_offset,
    })
}

/// A cursor that no longer names the bytes it was issued for.
fn stale_cursor() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "the cursor is no longer valid for this transcript",
    )
}

/// Locate the newline that ends the line starting at `from`, hashing the bytes
/// before it. Returns `(line_end, fingerprint)`.
fn scan_line(file: &mut File, from: u64, file_len: u64) -> io::Result<(u64, u64)> {
    let mut cursor = from;
    let mut hash = fingerprint::FNV_OFFSET;
    let mut buffer = vec![0u8; SCAN_CHUNK];
    while cursor < file_len {
        let span = usize::try_from((file_len - cursor).min(SCAN_CHUNK as u64))
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "scan chunk too large"))?;
        file.seek(SeekFrom::Start(cursor))?;
        let filled = buffer
            .get_mut(..span)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "scan span too large"))?;
        file.read_exact(filled)?;
        if let Some(index) = filled.iter().position(|byte| *byte == b'\n') {
            hash = fingerprint::update(hash, filled.get(..index).unwrap_or(&[]));
            return Ok((cursor + index as u64, hash));
        }
        hash = fingerprint::update(hash, filled);
        cursor += span as u64;
    }
    Ok((file_len, hash))
}

/// The fingerprint of the file's bytes in `[start, end)`.
fn fingerprint_range(file: &mut File, start: u64, end: u64) -> io::Result<u64> {
    let mut cursor = start;
    let mut hash = fingerprint::FNV_OFFSET;
    let mut buffer = vec![0u8; SCAN_CHUNK];
    while cursor < end {
        let span = usize::try_from((end - cursor).min(SCAN_CHUNK as u64))
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "hash chunk too large"))?;
        file.seek(SeekFrom::Start(cursor))?;
        let filled = buffer
            .get_mut(..span)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "hash span too large"))?;
        file.read_exact(filled)?;
        hash = fingerprint::update(hash, filled);
        cursor += span as u64;
    }
    Ok(hash)
}

/// Move a requested chunk start back to a UTF-8 character boundary.
///
/// Our own responses always hand out character boundaries, so this only matters
/// for a hand-edited request. Reporting the adjusted offset lets the caller
/// continue from where the chunk actually started.
fn adjust_start(file: &mut File, line_start: u64, relative: u64) -> io::Result<u64> {
    if relative == 0 {
        return Ok(0);
    }
    let back = relative.min(3);
    let mut probe = vec![0u8; back as usize];
    file.seek(SeekFrom::Start(line_start + relative - back))?;
    file.read_exact(&mut probe)?;
    for (index, byte) in probe.iter().enumerate().rev() {
        if byte & 0xC0 != 0x80 {
            return Ok(relative - (probe.len() - index) as u64);
        }
    }
    Ok(relative)
}

/// Keep the largest prefix of `bytes` that does not end mid-character.
fn floor_char_boundary(bytes: &[u8]) -> usize {
    let mut index = bytes.len();
    let mut examined = 0;
    while index > 0 && examined < 4 {
        index -= 1;
        examined += 1;
        let Some(&byte) = bytes.get(index) else {
            break;
        };
        if byte & 0xC0 != 0x80 {
            let needed = match byte {
                0x00..=0x7F => 1,
                0xC0..=0xDF => 2,
                0xE0..=0xEF => 3,
                0xF0..=0xF7 => 4,
                _ => 1,
            };
            return if index + needed > bytes.len() {
                index
            } else {
                bytes.len()
            };
        }
    }
    bytes.len()
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        if let (Some(high), Some(low)) = (
            DIGITS.get((byte >> 4) as usize),
            DIGITS.get((byte & 0x0F) as usize),
        ) {
            out.push(*high as char);
            out.push(*low as char);
        }
    }
    out
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let high = hex_value(*pair.first()?)?;
        let low = hex_value(*pair.get(1)?)?;
        out.push((high << 4) | low);
    }
    Some(out)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A transcript written to a temporary directory, with its `Discovered`.
    fn transcript(body: &str) -> (tempfile::TempDir, Discovered) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, body).unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");
        (dir, discovered)
    }

    fn lines(page: &RawPage) -> Vec<&str> {
        page.records
            .iter()
            .map(|record| record.raw.as_deref().expect("carried inline"))
            .collect()
    }

    #[test]
    fn every_physical_line_is_one_record_in_source_order() {
        // The property the whole view rests on: unknown types and malformed
        // JSON are records too, and nothing is absorbed or paired away.
        let body = concat!(
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hello"}}"#,
            "\n",
            r#"{"type":"quantum-entanglement-state","uuid":"q1"}"#,
            "\n",
            "not json at all\n",
            r#"{"type":"assistant","uuid":"a1"}"#,
            "\n",
        );
        let (_dir, discovered) = transcript(body);
        let page = read_page(&discovered, None, 50).unwrap();

        assert_eq!(lines(&page), body.lines().collect::<Vec<_>>());
        assert_eq!(page.records.len(), 4);
        assert!(!page.has_more);
        assert!(!page.partial_tail);
    }

    #[test]
    fn offsets_are_stable_and_advance_by_line_bytes() {
        let body = "one\nsecond\nthird\n";
        let (_dir, discovered) = transcript(body);
        let page = read_page(&discovered, None, 50).unwrap();
        assert_eq!(
            page.records
                .iter()
                .map(|record| record.offset)
                .collect::<Vec<_>>(),
            vec![0, 4, 11]
        );
        assert_eq!(page.records[1].size_bytes, 6);
    }

    #[test]
    fn an_invalid_utf8_line_does_not_move_the_next_offset() {
        // Offsets and sizes are properties of the file. A line decoded lossily
        // grows into replacement characters, which must not shift the record
        // after it onto the wrong bytes (`#4027`).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"ok\n\xff\xfe\nthird\n").unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");
        let page = read_page(&discovered, None, 50).unwrap();

        assert_eq!(
            page.records
                .iter()
                .map(|record| record.offset)
                .collect::<Vec<_>>(),
            vec![0, 3, 6]
        );
        assert_eq!(page.records[1].size_bytes, 2);
        assert_eq!(page.records[2].size_bytes, 5);
    }

    #[test]
    fn a_cursor_inside_a_line_is_not_a_page_boundary() {
        let (_dir, discovered) = transcript("one\ntwo\n");
        let mut file = File::open(discovered.path()).unwrap();
        let span_end = file.metadata().unwrap().len();
        let end = 1; // inside "one"
        let fingerprint = fingerprint_range(&mut file, end, span_end).unwrap();
        let cursor = Cursor {
            transcript_id: "test-session".into(),
            end,
            span_end,
            fingerprint,
        };
        let error = read_page(&discovered, Some(&cursor), 10).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_cursor_from_before_a_truncation_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");
        let page = read_page(&discovered, None, 1).unwrap();
        let cursor = page.next_cursor.expect("an older page");

        // The file shrank below the page the cursor was issued with.
        std::fs::write(&path, "one\ntwo\n").unwrap();
        let error = read_page(&discovered, Some(&cursor), 10).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_reference_past_the_end_is_not_found() {
        let (_dir, discovered) = transcript("hello\n");
        let read = read_record(&discovered, 0, 999, 0, CHUNK_CEILING).unwrap();
        assert_eq!(read, RecordRead::NotFound);
    }

    #[test]
    fn an_oversized_record_is_visible_as_a_placeholder_with_its_size() {
        // Not skipped, and not truncated while claiming to be the record.
        let huge = "x".repeat(RECORD_INLINE_CEILING * 2);
        let body = format!("{huge}\n");
        let (_dir, discovered) = transcript(&body);
        let page = read_page(&discovered, None, 50).unwrap();

        assert_eq!(page.records.len(), 1, "the record was dropped");
        let record = &page.records[0];
        assert!(
            record.raw.is_none(),
            "an oversized record was carried inline"
        );
        assert_eq!(record.size_bytes, huge.len() as u64);
    }

    #[test]
    fn the_page_budget_turns_later_records_into_placeholders_without_dropping_them() {
        let body = (0..8)
            .map(|_i| format!("{}\n", "y".repeat(RECORD_INLINE_CEILING)))
            .collect::<String>();
        let (_dir, discovered) = transcript(&body);
        let page = read_page(&discovered, None, 50).unwrap();

        assert_eq!(page.records.len(), 8, "a record was dropped");
        let carried = page
            .records
            .iter()
            .filter(|record| record.raw.is_some())
            .count();
        assert_eq!(
            carried,
            PAGE_INLINE_BUDGET / RECORD_INLINE_CEILING,
            "the page carried more than its budget"
        );
        assert!(
            page.records[carried..]
                .iter()
                .all(|record| record.raw.is_none()),
            "degradation is not deterministic"
        );
    }

    #[test]
    fn a_partial_trailing_line_is_withheld_until_complete() {
        let body = concat!(
            r#"{"type":"user","uuid":"u1"}"#,
            "\n",
            r#"{"type":"user","uuid":"u2","mess"#,
        );
        let (_dir, discovered) = transcript(body);
        let page = read_page(&discovered, None, 50).unwrap();

        assert_eq!(page.records.len(), 1, "an unfinished line became a record");
        assert!(page.partial_tail);
    }

    #[test]
    fn walking_the_cursor_reaches_every_record_exactly_once() {
        let body = "one\ntwo\nthree\nfour\nfive\n";
        let (_dir, discovered) = transcript(body);

        let mut seen: Vec<String> = Vec::new();
        let mut cursor = None;
        loop {
            let page = read_page(&discovered, cursor.as_ref(), 2).unwrap();
            for record in &page.records {
                seen.push(record.raw.clone().unwrap());
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        assert_eq!(seen, vec!["four", "five", "two", "three", "one"]);
        // Pages walk backwards from the newest record, and each page is in
        // source order. Sorting proves every record appeared exactly once.
        seen.sort_unstable();
        assert_eq!(seen, vec!["five", "four", "one", "three", "two"]);
    }

    #[test]
    fn an_oversized_record_reads_back_completely_in_chunks() {
        let huge = "z".repeat(RECORD_INLINE_CEILING * 2 + 17);
        let body = format!("{huge}\n");
        let (_dir, discovered) = transcript(&body);
        let page = read_page(&discovered, None, 50).unwrap();
        let record = &page.records[0];

        let mut collected = String::new();
        let mut offset = 0;
        loop {
            let read = read_record(
                &discovered,
                record.fingerprint,
                record.offset,
                offset,
                CHUNK_CEILING,
            )
            .unwrap();
            let RecordRead::Ready {
                raw,
                offset: at,
                size_bytes,
                has_more,
                next_offset,
            } = read
            else {
                panic!("expected a chunk, got {read:?}");
            };
            assert_eq!(at, offset);
            assert_eq!(size_bytes, huge.len() as u64);
            collected.push_str(&raw);
            if !has_more {
                break;
            }
            offset = next_offset;
        }
        assert_eq!(collected, huge);
    }

    #[test]
    fn a_reference_from_a_replaced_file_is_stale_rather_than_resolved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, "first\nsecond\n").unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");
        let page = read_page(&discovered, None, 50).unwrap();
        let record = page.records[0].clone();

        std::fs::write(&path, "replacement\nsecond\n").unwrap();
        let read = read_record(
            &discovered,
            record.fingerprint,
            record.offset,
            0,
            CHUNK_CEILING,
        )
        .unwrap();
        assert_eq!(read, RecordRead::StaleGeneration);
    }

    #[test]
    fn a_rewrite_that_preserves_the_first_line_is_stale_for_both_identities() {
        // `#4027`: a generation built from the first line alone still matched
        // after this rewrite, so the old reference returned "new" under the
        // identity issued for "old" — and the old cursor paged a file it had
        // never been issued against.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"header\"}\n{\"type\":\"assistant\",\"text\":\"old\"}\n",
        )
        .unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");

        let page = read_page(&discovered, None, 1).unwrap();
        let record = page.records[0].clone();
        let cursor = page.next_cursor.expect("an older page");
        assert_eq!(
            record.raw.as_deref(),
            Some("{\"type\":\"assistant\",\"text\":\"old\"}")
        );

        // Rewrite in place: same first line, different second record, same
        // length, so every offset the old identities carry stays in bounds.
        std::fs::write(
            &path,
            "{\"type\":\"header\"}\n{\"type\":\"assistant\",\"text\":\"new\"}\n",
        )
        .unwrap();

        let read = read_record(
            &discovered,
            record.fingerprint,
            record.offset,
            0,
            CHUNK_CEILING,
        )
        .unwrap();
        assert_eq!(read, RecordRead::StaleGeneration);

        let error = read_page(&discovered, Some(&cursor), 10).unwrap_err();
        assert_eq!(
            error.kind(),
            io::ErrorKind::InvalidInput,
            "the cursor accepted a page whose records were rewritten"
        );

        // A fresh read sees the rewritten record under a fresh identity.
        let fresh = read_page(&discovered, None, 10).unwrap();
        assert_eq!(
            lines(&fresh),
            vec![
                "{\"type\":\"header\"}",
                "{\"type\":\"assistant\",\"text\":\"new\"}",
            ]
        );
    }

    #[test]
    fn appending_records_leaves_earlier_references_and_cursors_usable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, "header\nsecond\n").unwrap();
        let discovered = crate::conversation::tests_support::discovered_at(&path, "/w");

        let page = read_page(&discovered, None, 1).unwrap();
        let record = page.records[0].clone();
        let cursor = page.next_cursor.expect("an older page");

        // Append a complete record. Every byte an identity was issued for is
        // untouched, so both must keep working (`#4027` SC-02).
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"third\n")
            .unwrap();

        let read = read_record(
            &discovered,
            record.fingerprint,
            record.offset,
            0,
            CHUNK_CEILING,
        )
        .unwrap();
        let RecordRead::Ready { raw, .. } = read else {
            panic!("an append invalidated a live reference: {read:?}");
        };
        assert_eq!(raw, "second");

        let older = read_page(&discovered, Some(&cursor), 10).unwrap();
        assert_eq!(
            lines(&older),
            vec!["header"],
            "an append invalidated a live cursor"
        );

        let fresh = read_page(&discovered, None, 10).unwrap();
        assert_eq!(lines(&fresh), vec!["header", "second", "third"]);
    }

    #[test]
    fn an_offset_inside_a_line_is_not_a_record_reference() {
        let (_dir, discovered) = transcript("hello world\n");
        let page = read_page(&discovered, None, 50).unwrap();
        let read = read_record(
            &discovered,
            page.records[0].fingerprint,
            3,
            0,
            CHUNK_CEILING,
        )
        .unwrap();
        assert_eq!(read, RecordRead::NotFound);
    }

    #[test]
    fn a_record_reference_round_trips_without_a_path() {
        let reference = encode_record_ref("session/agent-1", 4242, 0x0123_4567_89ab_cdef);
        let Some(Reference::Record(decoded)) = decode_ref(&reference) else {
            panic!("round trip");
        };
        assert_eq!(decoded.transcript_id, "session/agent-1");
        assert_eq!(decoded.offset, 4242);
        assert_eq!(decoded.fingerprint, 0x0123_4567_89ab_cdef);
        assert!(!reference.contains("subagents"));
        assert!(!reference.contains(".jsonl"));
    }

    #[test]
    fn a_cursor_round_trips_its_span() {
        let cursor = Cursor {
            transcript_id: "session-1".into(),
            end: 10,
            span_end: 40,
            fingerprint: 0xfeed_face,
        };
        let Some(Reference::Cursor(decoded)) = decode_ref(&encode_cursor(&cursor)) else {
            panic!("round trip");
        };
        assert_eq!(decoded, cursor);
    }

    #[test]
    fn a_foreign_or_malformed_reference_decodes_to_nothing() {
        assert!(decode_ref("not-a-reference").is_none());
        // The first-line-only format cannot be upgraded into the stronger
        // identity, so it is refused rather than misread (`#4027`).
        assert!(decode_ref("tr1:6162:0:gen").is_none());
        assert!(decode_ref("tr2:nothex:r:0:0").is_none());
        assert!(decode_ref("tr2:6162:r:0").is_none());
        assert!(decode_ref("tr2:6162:r:0:0:extra").is_none());
        assert!(decode_ref("tr2:6162:x:0:0").is_none());
        assert!(
            decode_ref("tr2:6162:c:10:5:0").is_none(),
            "a validated span cannot end before it starts"
        );
    }

    #[test]
    fn a_chunk_boundary_never_splits_a_character() {
        // Three-byte characters: a chunk that ends mid-character would give the
        // client a broken string, and the next chunk would not repair it.
        let line: String = "中".repeat(10);
        let body = format!("{line}\n");
        let (_dir, discovered) = transcript(&body);
        let page = read_page(&discovered, None, 50).unwrap();
        let record = &page.records[0];

        let RecordRead::Ready {
            raw,
            has_more,
            next_offset,
            ..
        } = read_record(&discovered, record.fingerprint, record.offset, 0, 10).unwrap()
        else {
            panic!("expected a chunk");
        };
        assert!(has_more);
        assert_eq!(raw, "中中中", "{raw:?}");
        assert_eq!(raw.len(), 9);
        assert_eq!(next_offset, 9, "the next chunk offset is not on a boundary");
    }

    #[test]
    fn reading_from_an_offset_inside_a_multibyte_character_backs_up_to_a_boundary() {
        let body = format!("{}\n", "中".repeat(4));
        let (_dir, discovered) = transcript(&body);
        let page = read_page(&discovered, None, 50).unwrap();
        let record = &page.records[0];

        let RecordRead::Ready { raw, offset, .. } =
            read_record(&discovered, record.fingerprint, record.offset, 4, 1024).unwrap()
        else {
            panic!("expected a chunk");
        };
        assert_eq!(offset, 3, "a mid-character offset was not adjusted");
        assert_eq!(raw.len(), 9);
    }
}
