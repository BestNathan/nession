//! Bounded backwards tail across ordered rolling files.
//!
//! Files are read newest first, in fixed-size chunks from the end. Only the
//! partial line that crosses a chunk boundary is ever buffered, so memory is
//! bounded by one chunk plus one capped line/record — not by history size.
//! Matching records are kept until `--tail` is satisfied or every file is
//! exhausted (#4600 SC-03).
//!
//! Runtime records are header + continuation lines. A record whose header sits
//! in an older file (the rotation boundary split it) is completed when the
//! older file is read: continuations are carried across file boundaries until
//! their header is found.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::ops::ControlFlow;
use std::path::PathBuf;

use crate::local_logs::format::{parse_raw_header, parse_runtime_header, LineFormat, RecordHeader};
use crate::local_logs::query::LogQuery;

const CHUNK_BYTES: usize = 64 * 1024;

/// A single pathological line is truncated at this many bytes.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// A single record (header + continuations) is truncated at this many bytes.
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;

/// Counters a `logs` read reports to stderr instead of hiding.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TailStats {
    /// Records emitted.
    pub emitted: usize,
    /// Records excluded because a requested filter needed a field the raw
    /// record does not carry (no timestamp/severity/target).
    pub skipped_unparsed: usize,
    /// Lines truncated at [`MAX_LINE_BYTES`].
    pub truncated_lines: usize,
    /// Records truncated at [`MAX_RECORD_BYTES`].
    pub truncated_records: usize,
    /// Record fragments whose header is no longer present (retention deleted
    /// the file that held it).
    pub orphaned_records: usize,
}

/// The tail's output and diagnostics.
#[derive(Debug, Default)]
pub struct TailOutput {
    pub lines: Vec<String>,
    pub stats: TailStats,
}

/// Read the last `query.tail` matching records from `files`, oldest first in
/// the returned lines.
pub fn read_tail(
    files: &[PathBuf],
    query: &LogQuery,
    format: LineFormat,
) -> io::Result<TailOutput> {
    read_tail_capped(files, query, format, None)
}

/// Read the tail with the newest file observed up to `newest_cap`.
///
/// Follow passes the snapshot it starts from, so a line appended between the
/// tail and the follow loop is either in both or in neither (#4600 SC-03).
pub fn read_tail_capped(
    files: &[PathBuf],
    query: &LogQuery,
    format: LineFormat,
    newest_cap: Option<(&PathBuf, u64)>,
) -> io::Result<TailOutput> {
    let mut scanner = Scanner::new(query, format);
    if query.tail == 0 {
        return Ok(TailOutput::default());
    }
    for path in files.iter().rev() {
        let cap = match newest_cap {
            Some((capped_path, offset)) if capped_path == path => Some(offset),
            _ => None,
        };
        let truncated = for_each_line_reverse(path, cap, |line| scanner.on_line(line))?;
        scanner.stats.truncated_lines += truncated;
        if scanner.done {
            break;
        }
    }
    Ok(scanner.finish())
}

/// Emit `path`'s lines newest first, stopping when `f` breaks.
///
/// Returns the number of lines truncated at [`MAX_LINE_BYTES`].
fn for_each_line_reverse(
    path: &PathBuf,
    cap: Option<u64>,
    mut f: impl FnMut(String) -> ControlFlow<()>,
) -> io::Result<usize> {
    let mut file = File::open(path)?;
    let mut end = file.metadata()?.len();
    if let Some(cap) = cap {
        end = end.min(cap);
    }
    let mut pending: Vec<u8> = Vec::new();
    let mut truncated = 0usize;
    let mut broken = false;
    while end > 0 && !broken {
        let start = end.saturating_sub(CHUNK_BYTES as u64);
        let size = usize::try_from(end - start).unwrap_or(usize::MAX);
        file.seek(SeekFrom::Start(start))?;
        let mut chunk = vec![0u8; size];
        file.read_exact(&mut chunk)?;
        chunk.extend_from_slice(&pending);
        let mut parts: Vec<&[u8]> = chunk.split(|byte| *byte == b'\n').collect();
        if chunk.last() == Some(&b'\n') {
            parts.pop();
        }
        if start == 0 {
            pending.clear();
            for part in parts.iter().rev() {
                let (line, was_truncated) = line_from_bytes(part);
                truncated += usize::from(was_truncated);
                if f(line).is_break() {
                    broken = true;
                    break;
                }
            }
        } else if let Some((first, rest)) = parts.split_first() {
            let (pending_bytes, was_truncated) = cap_pending(first);
            truncated += usize::from(was_truncated);
            pending = pending_bytes;
            for part in rest.iter().rev() {
                let (line, was_truncated) = line_from_bytes(part);
                truncated += usize::from(was_truncated);
                if f(line).is_break() {
                    broken = true;
                    break;
                }
            }
        } else {
            pending.clear();
        }
        end = start;
    }
    Ok(truncated)
}

fn cap_pending(bytes: &[u8]) -> (Vec<u8>, bool) {
    if bytes.len() <= MAX_LINE_BYTES {
        return (bytes.to_vec(), false);
    }
    (
        bytes
            .get(bytes.len() - MAX_LINE_BYTES..)
            .unwrap_or_default()
            .to_vec(),
        true,
    )
}

fn line_from_bytes(bytes: &[u8]) -> (String, bool) {
    let truncated = bytes.len() > MAX_LINE_BYTES;
    let bytes = if truncated {
        bytes.get(..MAX_LINE_BYTES).unwrap_or(bytes)
    } else {
        bytes
    };
    let text = String::from_utf8_lossy(bytes).into_owned();
    let text = text.strip_suffix('\r').unwrap_or(&text).to_string();
    if truncated {
        (
            format!("{text}... [nession logs: line truncated at {MAX_LINE_BYTES} bytes]"),
            true,
        )
    } else {
        (text, false)
    }
}

struct Scanner<'a> {
    query: &'a LogQuery,
    format: LineFormat,
    /// Continuation lines of the record being assembled, newest first.
    continuation: Vec<String>,
    continuation_bytes: usize,
    continuation_truncated: bool,
    /// Matched records, newest first.
    matches: Vec<Vec<String>>,
    stats: TailStats,
    done: bool,
}

impl<'a> Scanner<'a> {
    fn new(query: &'a LogQuery, format: LineFormat) -> Self {
        Self {
            query,
            format,
            continuation: Vec::new(),
            continuation_bytes: 0,
            continuation_truncated: false,
            matches: Vec::new(),
            stats: TailStats::default(),
            done: false,
        }
    }

    fn on_line(&mut self, line: String) -> ControlFlow<()> {
        match self.format {
            LineFormat::Raw => {
                let header = parse_raw_header(&line);
                self.consider(header, vec![line]);
            }
            LineFormat::Runtime => match parse_runtime_header(&line) {
                Some(header) => {
                    let mut lines = Vec::with_capacity(self.continuation.len() + 1);
                    lines.push(line);
                    lines.extend(self.continuation.drain(..).rev());
                    self.continuation_bytes = 0;
                    let truncated = std::mem::take(&mut self.continuation_truncated);
                    if truncated {
                        self.stats.truncated_records += 1;
                    }
                    self.consider(header, lines);
                }
                None => {
                    if self.continuation_bytes + line.len() > MAX_RECORD_BYTES {
                        self.continuation_truncated = true;
                    } else {
                        self.continuation_bytes += line.len();
                        self.continuation.push(line);
                    }
                }
            },
        }
        if self.done {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    }

    fn consider(&mut self, header: RecordHeader, lines: Vec<String>) {
        let matched = if !self.query.needs_header() {
            true
        } else if crate::local_logs::follow::missing_filter_field(self.query, &header) {
            self.stats.skipped_unparsed += 1;
            false
        } else {
            self.query.matches(&header)
        };
        if matched {
            self.matches.push(lines);
            self.stats.emitted += 1;
            if self.stats.emitted == self.query.tail {
                self.done = true;
            }
        }
    }

    fn finish(mut self) -> TailOutput {
        // A partial record with no header survived to the oldest file: the
        // history begins mid-record (retention deleted the header's file) or
        // the file starts with a continuation. Preserve it only when no filter
        // would have to infer a field it does not have.
        if !self.continuation.is_empty() {
            self.stats.orphaned_records += 1;
            let lines: Vec<String> = self.continuation.drain(..).rev().collect();
            if self.query.needs_header() {
                self.stats.skipped_unparsed += 1;
            } else {
                self.stats.emitted += 1;
                self.matches.push(lines);
            }
        }
        if self.continuation_truncated {
            self.stats.truncated_records += 1;
        }
        let mut output = TailOutput {
            lines: Vec::new(),
            stats: std::mem::take(&mut self.stats),
        };
        for mut record in self.matches.into_iter().rev() {
            output.lines.append(&mut record);
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::LogsArgs;
    use crate::local_logs::query::{LogQuery, LogSource};
    use nession_common::logging::LogComponent;
    use std::path::Path;

    fn query(tail: usize) -> LogQuery {
        LogQuery {
            component: LogComponent::Agent,
            source: LogSource::Runtime,
            tail,
            follow: false,
            since: None,
            until: None,
            level: None,
            target: None,
            path_only: false,
        }
    }

    fn runtime_line(second: u32, level: &str, target: &str, message: &str) -> String {
        format!("2026-11-26T10:00:{second:02}.000000Z  {level} {target}: {message}")
    }

    fn write_file(dir: &Path, name: &str, lines: &[String]) {
        let mut content = lines.join("\n");
        if !lines.is_empty() {
            content.push('\n');
        }
        std::fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn the_tail_is_taken_across_files_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let old: Vec<String> = (0..5)
            .map(|index| runtime_line(index, "INFO", "app", &format!("old {index}")))
            .collect();
        let new: Vec<String> = (0..5)
            .map(|index| runtime_line(index, "INFO", "app", &format!("new {index}")))
            .collect();
        write_file(dir.path(), "nession-agent.2026-11-25", &old);
        write_file(dir.path(), "nession-agent.2026-11-26", &new);
        let files = vec![
            dir.path().join("nession-agent.2026-11-25"),
            dir.path().join("nession-agent.2026-11-26"),
        ];

        let output = read_tail(&files, &query(3), LineFormat::Runtime).unwrap();

        assert_eq!(output.stats.emitted, 3);
        let lines: Vec<String> = output.lines;
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("new 2"), "{lines:?}");
        assert!(lines[1].contains("new 3"), "{lines:?}");
        assert!(lines[2].contains("new 4"), "{lines:?}");
    }

    #[test]
    fn filtering_happens_before_the_tail() {
        let dir = tempfile::tempdir().unwrap();
        let mut lines = Vec::new();
        for index in 0..50 {
            lines.push(runtime_line(
                index % 60,
                if index % 2 == 0 { "INFO" } else { "WARN" },
                if index % 5 == 0 {
                    "nession_agent::ws"
                } else {
                    "nession_agent::other"
                },
                &format!("record {index}"),
            ));
        }
        write_file(dir.path(), "nession-agent", &lines);
        let files = vec![dir.path().join("nession-agent")];

        let mut level_query = query(2);
        level_query.level = Some(crate::local_logs::query::LogLevel::Warn);
        let output = read_tail(&files, &level_query, LineFormat::Runtime).unwrap();
        assert_eq!(output.stats.emitted, 2);
        assert!(output.lines[0].contains("WARN"), "{:?}", output.lines);
        assert!(output.lines.iter().all(|line| line.contains("WARN")));

        let mut target_query = query(10);
        target_query.target = Some("nession_agent::ws".to_string());
        let output = read_tail(&files, &target_query, LineFormat::Runtime).unwrap();
        assert_eq!(output.stats.emitted, 10);
        assert!(output
            .lines
            .iter()
            .all(|line| line.contains("nession_agent::ws:")));
    }

    #[test]
    fn a_zero_tail_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "nession-agent",
            &[runtime_line(1, "INFO", "app", "one")],
        );
        let files = vec![dir.path().join("nession-agent")];
        let output = read_tail(&files, &query(0), LineFormat::Runtime).unwrap();
        assert!(output.lines.is_empty());
        assert_eq!(output.stats.emitted, 0);
    }

    #[test]
    fn records_are_not_split_across_chunk_boundaries() {
        // A record far larger than one chunk must still be returned whole.
        let dir = tempfile::tempdir().unwrap();
        let long_message = "x".repeat(CHUNK_BYTES + 1024);
        let lines = vec![
            runtime_line(1, "INFO", "app", "before"),
            runtime_line(2, "INFO", "app", &long_message),
            runtime_line(3, "INFO", "app", "after"),
        ];
        write_file(dir.path(), "nession-agent", &lines);
        let files = vec![dir.path().join("nession-agent")];

        let output = read_tail(&files, &query(2), LineFormat::Runtime).unwrap();
        assert_eq!(output.lines.len(), 2, "{:?}", output.lines.len());
        assert!(output.lines[0].contains(&long_message));
        assert!(output.lines[1].contains("after"));
    }

    #[test]
    fn a_multiline_record_is_filtered_and_tailed_as_one_record() {
        let dir = tempfile::tempdir().unwrap();
        let lines = vec![
            runtime_line(1, "INFO", "app", "first"),
            runtime_line(2, "ERROR", "app", "start of error"),
            "  continuation line".to_string(),
            runtime_line(3, "INFO", "app", "last"),
        ];
        write_file(dir.path(), "nession-agent", &lines);
        let files = vec![dir.path().join("nession-agent")];

        let mut error_query = query(5);
        error_query.level = Some(crate::local_logs::query::LogLevel::Error);
        let output = read_tail(&files, &error_query, LineFormat::Runtime).unwrap();
        assert_eq!(output.stats.emitted, 1);
        assert_eq!(output.lines.len(), 2, "{:?}", output.lines);
        assert!(output.lines[1].contains("continuation"));
    }

    #[test]
    fn raw_sources_count_unparsed_records_instead_of_guessing() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "startup.log",
            &[
                "2026-11-26T10:00:00.000Z agent config: one".to_string(),
                "plain raw line".to_string(),
            ],
        );
        let files = vec![dir.path().join("startup.log")];
        let mut raw_query = query(10);
        raw_query.since = Some(
            chrono::DateTime::parse_from_rfc3339("2026-11-26T09:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        );
        let output = read_tail(&files, &raw_query, LineFormat::Raw).unwrap();
        assert_eq!(output.stats.emitted, 1);
        assert_eq!(output.stats.skipped_unparsed, 1);

        let all = read_tail(&files, &query(10), LineFormat::Raw).unwrap();
        assert_eq!(all.lines.len(), 2);
    }

    #[test]
    fn an_oversized_line_is_truncated_with_a_marker() {
        let dir = tempfile::tempdir().unwrap();
        let long = "y".repeat(MAX_LINE_BYTES + 10);
        write_file(
            dir.path(),
            "nession-agent",
            &[format!("2026-11-26T10:00:00Z INFO app: {long}")],
        );
        let files = vec![dir.path().join("nession-agent")];
        let output = read_tail(&files, &query(1), LineFormat::Runtime).unwrap();
        assert_eq!(output.stats.truncated_lines, 1);
        assert!(
            output.lines[0].contains("line truncated"),
            "{:?}",
            output.lines[0].len()
        );
    }

    #[test]
    fn the_query_builder_is_the_only_default_owner() {
        let built = LogQuery::build(
            LogComponent::Agent,
            &LogsArgs {
                tail: None,
                follow: false,
                since: None,
                until: None,
                level: None,
                target: None,
                path: false,
                source: crate::args::LogSourceArg::Runtime,
                pid_file: None,
            },
        )
        .unwrap();
        assert_eq!(built.tail, crate::local_logs::query::DEFAULT_TAIL);
    }
}
