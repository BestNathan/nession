//! Line/record shape of the two file sources.
//!
//! Runtime files are written by `tracing_subscriber`'s default formatter:
//!
//! ```text
//! 2026-11-26T10:06:27.794344Z  INFO nession_agent::runtime: starting
//! ```
//!
//! A message may contain newlines, so a record is one header line plus any
//! continuation lines. Filtering is applied to the whole record; a
//! continuation line is never classified on its own (#4600 SC-03).
//!
//! Startup and managed-service captures are raw text: a line either carries
//! an RFC3339 timestamp as its first token (startup records) or is opaque. No
//! severity or target is ever inferred from raw text.

use chrono::{DateTime, Utc};

use crate::local_logs::query::LogLevel;

/// The parsed header of one runtime record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordHeader {
    pub timestamp: Option<DateTime<Utc>>,
    pub level: Option<LogLevel>,
    pub target: Option<String>,
}

impl RecordHeader {
    /// A header with no timestamp (used for startup raw lines that predate the
    /// timestamp, and by tests).
    pub fn untimed() -> Self {
        Self {
            timestamp: None,
            level: None,
            target: None,
        }
    }
}

/// How a source's lines are shaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineFormat {
    /// `tracing_subscriber` default text: timestamp, level, target, message,
    /// plus continuation lines.
    Runtime,
    /// One line per record; the first token is an RFC3339 timestamp when the
    /// writer emitted one.
    Raw,
}

/// Parse a runtime header line, or `None` when the line is a continuation.
pub fn parse_runtime_header(line: &str) -> Option<RecordHeader> {
    let mut rest = line.trim_end_matches('\r');
    let timestamp_token = take_token(&mut rest)?;
    let timestamp = DateTime::parse_from_rfc3339(timestamp_token)
        .ok()
        .map(|value| value.with_timezone(&Utc))?;
    let level = LogLevel::parse(take_token(&mut rest)?)?;
    let target_token = take_token(&mut rest)?;
    let target = target_token.strip_suffix(':').unwrap_or(target_token);
    if target.is_empty() {
        return None;
    }
    Some(RecordHeader {
        timestamp: Some(timestamp),
        level: Some(level),
        target: Some(target.to_string()),
    })
}

/// Parse a startup record's line.
///
/// The line must start with an RFC3339 timestamp; the rest is the message. A
/// line without one is returned as an untimed record so the caller can decide
/// (and explicitly say) that a time filter skipped it.
pub fn parse_raw_header(line: &str) -> RecordHeader {
    let mut rest = line.trim_end_matches('\r');
    match take_token(&mut rest).and_then(|token| DateTime::parse_from_rfc3339(token).ok()) {
        Some(timestamp) => RecordHeader {
            timestamp: Some(timestamp.with_timezone(&Utc)),
            level: None,
            target: None,
        },
        None => RecordHeader::untimed(),
    }
}

fn take_token<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let trimmed = rest.trim_start();
    if trimmed.is_empty() {
        *rest = "";
        return None;
    }
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let token = &trimmed[..end];
    *rest = &trimmed[end..];
    Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runtime_header_is_parsed() {
        let header = parse_runtime_header(
            "2026-11-26T10:06:27.794344Z  INFO nession_agent::runtime: starting",
        )
        .expect("a runtime header");
        assert_eq!(header.level, Some(LogLevel::Info));
        assert_eq!(header.target.as_deref(), Some("nession_agent::runtime"));
        assert!(header.timestamp.is_some());
    }

    #[test]
    fn a_continuation_line_is_not_a_header() {
        assert!(parse_runtime_header("    continuation of a message").is_none());
        assert!(parse_runtime_header("plain text").is_none());
        assert!(parse_runtime_header("2026-11-26T10:06:27Z not-a-level t: x").is_none());
    }

    #[test]
    fn module_prefix_boundaries_are_not_substring_matches() {
        let header =
            parse_runtime_header("2026-11-26T10:06:27Z WARN nession_agent::wss: x").unwrap();
        assert_eq!(header.target.as_deref(), Some("nession_agent::wss"));
    }

    #[test]
    fn a_raw_line_with_a_timestamp_is_timed() {
        let header = parse_raw_header("2026-11-26T10:06:27.794Z agent config: failed");
        assert!(header.timestamp.is_some());
    }

    #[test]
    fn a_raw_line_without_a_timestamp_is_untimed() {
        assert_eq!(
            parse_raw_header("plain stderr line"),
            RecordHeader::untimed()
        );
    }
}
