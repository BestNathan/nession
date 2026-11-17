//! Raw transcript record access (`#3726`).
//!
//! Discovery and page selection already live in [`crate::conversation`]. This
//! module is the access layer the Transcript surface reads through: it selects
//! a page of physical JSONL lines without interpreting them, applies the raw
//! page budgets, and resolves one record in bounded chunks.
//!
//! ## Why a generation fingerprint
//!
//! A byte offset is only meaningful against the file it was computed from.
//! Transcripts are append-only in normal operation, so an offset stays valid
//! while the file grows — but a resumed session that rewrites or truncates a
//! transcript would silently turn an old offset into different bytes. Each
//! reference and cursor therefore carries a fingerprint of the file's first
//! line. It is stable across appends and changes when the file is replaced, so
//! a stale reference fails closed instead of reading the wrong record.
//!
//! ## Why a reference is hex, not a file path
//!
//! The reference is opaque on purpose: it carries the transcript identity and
//! the offset, never a path. The handler resolves the identity against the
//! Session's authorized transcript list before opening anything, so a client
//! cannot point this at an arbitrary file by editing a string.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use crate::conversation::{select_records, Discovered};
use crate::protocol::transcript_record::v1::CHUNK_CEILING;
use crate::protocol::transcript_records::v1::{PAGE_INLINE_BUDGET, RECORD_INLINE_CEILING};

/// Prefix identifying this reference format.
const REF_PREFIX: &str = "tr1";

/// How much of the first line the generation fingerprint reads.
const GENERATION_WINDOW: u64 = 4 * 1024;

/// How much to read at a time while locating a line's end.
const SCAN_CHUNK: usize = 64 * 1024;

/// One page of raw records.
#[derive(Debug, Clone, Default)]
pub(crate) struct RawPage {
    /// Oldest-first, one per non-empty physical line.
    pub(crate) records: Vec<RawRecord>,
    /// Byte offset to pass back to read the page before this one.
    pub(crate) next_offset: Option<u64>,
    pub(crate) has_more: bool,
    pub(crate) partial_tail: bool,
    /// The file's generation fingerprint, for encoding refs and the cursor.
    pub(crate) generation: String,
}

/// One raw record, with its original line when the page could carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawRecord {
    pub(crate) offset: u64,
    pub(crate) size_bytes: u64,
    /// The original line text, or `None` when it exceeded the inline bounds.
    pub(crate) raw: Option<String>,
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
    /// The reference was issued against a different file generation.
    StaleGeneration,
    /// The reference does not locate a record in this transcript.
    NotFound,
}

/// A decoded opaque reference or cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResourceRef {
    pub(crate) transcript_id: String,
    pub(crate) offset: u64,
    pub(crate) generation: String,
}

/// Encode a resource-scoped reference.
pub(crate) fn encode_ref(transcript_id: &str, offset: u64, generation: &str) -> String {
    format!(
        "{REF_PREFIX}:{}:{offset:x}:{generation}",
        hex_encode(transcript_id.as_bytes())
    )
}

/// Decode a reference, returning `None` for anything this version did not issue.
pub(crate) fn decode_ref(raw: &str) -> Option<ResourceRef> {
    let mut parts = raw.split(':');
    if parts.next()? != REF_PREFIX {
        return None;
    }
    let transcript_id = String::from_utf8(hex_decode(parts.next()?)?).ok()?;
    let offset = u64::from_str_radix(parts.next()?, 16).ok()?;
    let generation = parts.next()?.to_string();
    if parts.next().is_some() || generation.is_empty() {
        return None;
    }
    Some(ResourceRef {
        transcript_id,
        offset,
        generation,
    })
}

/// Read one page of the transcript as raw lines.
pub(crate) fn read_page(
    conversation: &Discovered,
    end_offset: Option<u64>,
    expected_generation: Option<&str>,
    limit: usize,
) -> io::Result<RawPage> {
    let mut file = File::open(conversation.path())?;
    let file_len = file.metadata()?.len();
    let generation = generation_of(&mut file)?;

    // Every cursor failure is `InvalidInput`, which the handler reports as
    // `stale_cursor`. Checking here, before selection, keeps a stale offset
    // from being applied to bytes it was not computed against.
    if expected_generation.is_some()
        && (expected_generation.is_some_and(|expected| expected != generation)
            || end_offset.is_some_and(|offset| offset > file_len))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the cursor is no longer valid for this transcript",
        ));
    }

    let end = end_offset.unwrap_or(file_len).min(file_len);
    // A cursor names a record boundary. A forged or damaged offset inside a
    // line would silently drop that line and page from the middle of it.
    if expected_generation.is_some() {
        if let Some(offset) = end_offset {
            if offset > 0 && offset < file_len {
                file.seek(SeekFrom::Start(offset - 1))?;
                let mut previous = [0u8; 1];
                file.read_exact(&mut previous)?;
                if previous[0] != b'\n' {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "cursor is not at a record boundary",
                    ));
                }
            }
        }
    }
    let selected = select_records(&mut file, file_len, end, limit)?;

    // If the file was replaced while the page was being selected, the bytes
    // describe one generation and the fingerprint another. Returning either
    // would be a claim the provider cannot support; the caller can re-read.
    if generation_of(&mut file)? != generation {
        return Err(io::Error::other(
            "the transcript changed while the page was being read",
        ));
    }

    let mut budget = PAGE_INLINE_BUDGET;
    let records = selected
        .records
        .into_iter()
        .map(|(offset, line)| {
            let size_bytes = line.len() as u64;
            let raw = if line.len() <= RECORD_INLINE_CEILING && line.len() <= budget {
                budget -= line.len();
                Some(line)
            } else {
                None
            };
            RawRecord {
                offset,
                size_bytes,
                raw,
            }
        })
        .collect();

    Ok(RawPage {
        records,
        next_offset: selected.next_offset,
        has_more: selected.has_more,
        partial_tail: selected.partial_tail,
        generation,
    })
}

/// Resolve one record reference to a bounded chunk of its line.
pub(crate) fn read_record(
    conversation: &Discovered,
    expected_generation: &str,
    line_offset: u64,
    chunk_offset: u64,
    chunk_limit: u32,
) -> io::Result<RecordRead> {
    let mut file = File::open(conversation.path())?;
    let file_len = file.metadata()?.len();

    if generation_of(&mut file)? != expected_generation {
        return Ok(RecordRead::StaleGeneration);
    }

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

    let line_end = find_line_end(&mut file, line_offset, file_len)?;
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
    if generation_of(&mut file)? != expected_generation {
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

/// The generation fingerprint of a transcript.
///
/// The first line is written once and never rewritten in normal operation;
/// appending new records does not change it, so a cursor survives live growth.
/// A resumed or replaced file changes it, which is exactly when old offsets
/// must stop being trusted.
pub(crate) fn generation_of(file: &mut File) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut head = Vec::new();
    file.by_ref()
        .take(GENERATION_WINDOW)
        .read_to_end(&mut head)?;
    let first = head.split(|byte| *byte == b'\n').next().unwrap_or(&[]);
    Ok(format!("{:016x}", fnv1a64(first)))
}

/// Locate the newline that ends the line starting at `from`, or EOF.
fn find_line_end(file: &mut File, from: u64, file_len: u64) -> io::Result<u64> {
    let mut cursor = from;
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
            return Ok(cursor + index as u64);
        }
        cursor += span as u64;
    }
    Ok(file_len)
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

/// FNV-1a, 64-bit. Stable across runs and platforms, unlike `DefaultHasher`.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
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
        let page = read_page(&discovered, None, None, 50).unwrap();

        assert_eq!(lines(&page), body.lines().collect::<Vec<_>>());
        assert_eq!(page.records.len(), 4);
        assert!(!page.has_more);
        assert!(!page.partial_tail);
    }

    #[test]
    fn offsets_are_stable_and_advance_by_line_bytes() {
        let body = "one\nsecond\nthird\n";
        let (_dir, discovered) = transcript(body);
        let page = read_page(&discovered, None, None, 50).unwrap();
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
    fn a_cursor_inside_a_line_is_not_a_page_boundary() {
        let (_dir, discovered) = transcript("one\ntwo\n");
        let mut file = File::open(discovered.path()).unwrap();
        let generation = generation_of(&mut file).unwrap();
        let error = read_page(&discovered, Some(1), Some(&generation), 10).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn an_oversized_record_is_visible_as_a_placeholder_with_its_size() {
        // Not skipped, and not truncated while claiming to be the record.
        let huge = "x".repeat(RECORD_INLINE_CEILING * 2);
        let body = format!("{huge}\n");
        let (_dir, discovered) = transcript(&body);
        let page = read_page(&discovered, None, None, 50).unwrap();

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
        let page = read_page(&discovered, None, None, 50).unwrap();

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
        let page = read_page(&discovered, None, None, 50).unwrap();

        assert_eq!(page.records.len(), 1, "an unfinished line became a record");
        assert!(page.partial_tail);
    }

    #[test]
    fn walking_the_cursor_reaches_every_record_exactly_once() {
        let body = "one\ntwo\nthree\nfour\nfive\n";
        let (_dir, discovered) = transcript(body);

        let mut seen: Vec<String> = Vec::new();
        let mut end = None;
        loop {
            let page = read_page(&discovered, end, None, 2).unwrap();
            for record in &page.records {
                seen.push(record.raw.clone().unwrap());
            }
            if !page.has_more {
                break;
            }
            end = page.next_offset;
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
        let page = read_page(&discovered, None, None, 50).unwrap();
        let record = &page.records[0];

        let mut collected = String::new();
        let mut offset = 0;
        loop {
            let read = read_record(
                &discovered,
                &page.generation,
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
        let page = read_page(&discovered, None, None, 50).unwrap();
        let old_generation = page.generation.clone();
        let record = page.records[0].clone();

        std::fs::write(&path, "replacement\nsecond\n").unwrap();
        let read = read_record(
            &discovered,
            &old_generation,
            record.offset,
            0,
            CHUNK_CEILING,
        )
        .unwrap();
        assert_eq!(read, RecordRead::StaleGeneration);
    }

    #[test]
    fn an_offset_inside_a_line_is_not_a_record_reference() {
        let (_dir, discovered) = transcript("hello world\n");
        let page = read_page(&discovered, None, None, 50).unwrap();
        let read = read_record(&discovered, &page.generation, 3, 0, CHUNK_CEILING).unwrap();
        assert_eq!(read, RecordRead::NotFound);
    }

    #[test]
    fn a_reference_round_trips_the_transcript_identity_and_offset() {
        let reference = encode_ref("session/agent-1", 4242, "0123456789abcdef");
        let decoded = decode_ref(&reference).expect("round trip");
        assert_eq!(decoded.transcript_id, "session/agent-1");
        assert_eq!(decoded.offset, 4242);
        assert_eq!(decoded.generation, "0123456789abcdef");
        assert!(!reference.contains("subagents"));
        assert!(!reference.contains(".jsonl"));
    }

    #[test]
    fn a_foreign_or_malformed_reference_decodes_to_nothing() {
        assert!(decode_ref("not-a-reference").is_none());
        assert!(decode_ref("tr1:nothex:0:gen").is_none());
        assert!(decode_ref("tr1:6162:0:").is_none());
        assert!(decode_ref("tr1:6162:0:gen:extra").is_none());
    }

    #[test]
    fn the_generation_is_stable_across_appends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, "first\n").unwrap();
        let mut file = File::open(&path).unwrap();
        let before = generation_of(&mut file).unwrap();

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"second\n")
            .unwrap();
        let mut file = File::open(&path).unwrap();
        let after = generation_of(&mut file).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn a_chunk_boundary_never_splits_a_character() {
        // Three-byte characters: a chunk that ends mid-character would give the
        // client a broken string, and the next chunk would not repair it.
        let line: String = "中".repeat(10);
        let body = format!("{line}\n");
        let (_dir, discovered) = transcript(&body);
        let page = read_page(&discovered, None, None, 50).unwrap();
        let record = &page.records[0];

        let RecordRead::Ready {
            raw,
            has_more,
            next_offset,
            ..
        } = read_record(&discovered, &page.generation, record.offset, 0, 10).unwrap()
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
        let page = read_page(&discovered, None, None, 50).unwrap();
        let record = &page.records[0];

        let RecordRead::Ready { raw, offset, .. } =
            read_record(&discovered, &page.generation, record.offset, 4, 1024).unwrap()
        else {
            panic!("expected a chunk");
        };
        assert_eq!(offset, 3, "a mid-character offset was not adjusted");
        assert_eq!(raw.len(), 9);
    }
}
