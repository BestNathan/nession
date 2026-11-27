//! The validated query behind `nession agent|server logs`.
//!
//! Argument *shape* belongs to `crate::args`; this module owns the semantic
//! contract — defaults, time parsing, and which combinations are refused
//! instead of silently ignored (#4600 SC-01).

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, Utc};
use nession_common::logging::LogComponent;

use crate::args::{LogLevelArg, LogSourceArg, LogsArgs};

/// Default number of matching lines when `-n/--tail` is omitted.
pub const DEFAULT_TAIL: usize = 100;

/// Which log source a query reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSource {
    Runtime,
    Startup,
    Service,
}

/// The minimum persisted severity to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_uppercase().as_str() {
            "TRACE" => Some(Self::Trace),
            "DEBUG" => Some(Self::Debug),
            "INFO" => Some(Self::Info),
            "WARN" => Some(Self::Warn),
            "ERROR" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn from_arg(arg: LogLevelArg) -> Self {
        match arg {
            LogLevelArg::Trace => Self::Trace,
            LogLevelArg::Debug => Self::Debug,
            LogLevelArg::Info => Self::Info,
            LogLevelArg::Warn => Self::Warn,
            LogLevelArg::Error => Self::Error,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// One validated read request.
#[derive(Debug, Clone)]
pub struct LogQuery {
    pub component: LogComponent,
    pub source: LogSource,
    pub tail: usize,
    pub follow: bool,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub level: Option<LogLevel>,
    pub target: Option<String>,
    pub path_only: bool,
}

impl LogQuery {
    /// Validate `args` for `component`.
    ///
    /// Every refusal names the contradiction. Nothing is silently downgraded:
    /// a raw source never pretends to have a severity or target, and a
    /// path-only request never carries content filters.
    pub fn build(component: LogComponent, args: &LogsArgs) -> Result<Self> {
        let source = match args.source {
            LogSourceArg::Runtime => LogSource::Runtime,
            LogSourceArg::Startup => LogSource::Startup,
            LogSourceArg::Service => LogSource::Service,
        };
        let level = args.level.map(LogLevel::from_arg);
        let target = args.target.as_ref().map(|value| value.trim().to_string());
        if let Some(target) = target.as_deref() {
            if target.is_empty() {
                bail!("--target must not be empty");
            }
            if target.chars().any(char::is_whitespace) {
                bail!("--target '{target}' must not contain whitespace");
            }
            if target.chars().any(char::is_control) {
                bail!("--target must not contain control characters");
            }
        }

        if args.path {
            let mut conflicting = Vec::new();
            if args.follow {
                conflicting.push("--follow");
            }
            if args.tail.is_some() {
                conflicting.push("--tail");
            }
            if args.since.is_some() {
                conflicting.push("--since");
            }
            if args.until.is_some() {
                conflicting.push("--until");
            }
            if args.level.is_some() {
                conflicting.push("--level");
            }
            if args.target.is_some() {
                conflicting.push("--target");
            }
            if !conflicting.is_empty() {
                bail!(
                    "--path only prints the resolved source location and cannot be combined \
                     with {}",
                    conflicting.join(", ")
                );
            }
        }

        if matches!(source, LogSource::Startup | LogSource::Service) {
            if level.is_some() {
                bail!(
                    "--level needs parsed severity, but --source {} contains raw text; \
                     remove --level or use --source runtime",
                    source.as_str()
                );
            }
            if target.is_some() {
                bail!(
                    "--target needs a parsed tracing target, but --source {} contains raw \
                     text; remove --target or use --source runtime",
                    source.as_str()
                );
            }
        }

        if source == LogSource::Service && component == LogComponent::Server {
            bail!(
                "the Server has no native managed service in this CLI, so `--source service` \
                 is unsupported; use --source runtime (or --source startup)"
            );
        }

        let now = Utc::now();
        let since = match args.since.as_deref() {
            Some(value) => Some(parse_since(value, now)?),
            None => None,
        };
        let until = match args.until.as_deref() {
            Some(value) => Some(
                DateTime::parse_from_rfc3339(value.trim())
                    .with_context(|| {
                        format!(
                            "invalid --until '{value}'; expected an RFC3339 timestamp with a \
                             UTC offset (for example 2026-11-26T12:00:00Z)"
                        )
                    })?
                    .with_timezone(&Utc),
            ),
            None => None,
        };
        if let (Some(since), Some(until)) = (since, until) {
            if since > until {
                bail!(
                    "--since ({}) is after --until ({}); the range is empty",
                    since.to_rfc3339(),
                    until.to_rfc3339()
                );
            }
        }

        Ok(Self {
            component,
            source,
            tail: args.tail.unwrap_or(DEFAULT_TAIL),
            follow: args.follow,
            since,
            until,
            level,
            target,
            path_only: args.path,
        })
    }

    /// Whether the record passes the time/level/target filters.
    pub fn matches(&self, header: &crate::local_logs::format::RecordHeader) -> bool {
        if let Some(level) = self.level {
            match header.level {
                Some(record_level) if record_level >= level => {}
                _ => return false,
            }
        }
        if let Some(target) = self.target.as_deref() {
            match header.target.as_deref() {
                Some(record_target)
                    if record_target == target
                        || record_target
                            .strip_prefix(target)
                            .is_some_and(|rest| rest.starts_with("::")) => {}
                _ => return false,
            }
        }
        if let Some(since) = self.since {
            match header.timestamp {
                Some(timestamp) if timestamp >= since => {}
                _ => return false,
            }
        }
        if let Some(until) = self.until {
            match header.timestamp {
                Some(timestamp) if timestamp <= until => {}
                _ => return false,
            }
        }
        true
    }

    /// Whether any filter needs a parsed record header.
    pub fn needs_header(&self) -> bool {
        self.level.is_some()
            || self.target.is_some()
            || self.since.is_some()
            || self.until.is_some()
    }
}

impl LogSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Startup => "startup",
            Self::Service => "service",
        }
    }
}

/// Parse `--since`: a duration relative to `now`, or an RFC3339 timestamp.
pub fn parse_since(value: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let value = value.trim();
    if value.is_empty() {
        bail!("--since must not be empty");
    }
    if let Some(duration) = parse_duration(value)? {
        return now
            .checked_sub_signed(duration)
            .context("--since duration overflows the supported time range");
    }
    match DateTime::parse_from_rfc3339(value) {
        Ok(timestamp) => Ok(timestamp.with_timezone(&Utc)),
        Err(_) => bail!(
            "invalid --since '{value}'; expected a duration (30m, 1h30m, 2d) or an RFC3339 \
             timestamp with a UTC offset (for example 2026-11-26T12:00:00Z)"
        ),
    }
}

/// A duration like `30m`, `1h30m`, `2d`, or `45s`; `None` when the text is not
/// a duration at all (so the caller can try an absolute timestamp).
fn parse_duration(text: &str) -> Result<Option<Duration>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    // A duration is only <digits><s|m|h|d> segments. Anything else is left to
    // the RFC3339 parser, which owns its own diagnostic.
    let mut rest = text;
    let mut total_seconds: i64 = 0;
    let mut segments = 0;
    while !rest.is_empty() {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return Ok(None);
        }
        rest = &rest[digits.len()..];
        let Some(unit) = rest.chars().next() else {
            return Ok(None);
        };
        let multiplier = match unit {
            's' => 1,
            'm' => 60,
            'h' => 60 * 60,
            'd' => 24 * 60 * 60,
            _ => return Ok(None),
        };
        let number: i64 = digits
            .parse()
            .with_context(|| format!("--since duration '{text}' is too large"))?;
        total_seconds = total_seconds
            .checked_add(
                number
                    .checked_mul(multiplier)
                    .context("--since duration is too large")?,
            )
            .context("--since duration is too large")?;
        rest = &rest[1..];
        segments += 1;
    }
    if segments == 0 {
        return Ok(None);
    }
    Ok(Some(Duration::seconds(total_seconds)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn args() -> LogsArgs {
        LogsArgs {
            tail: None,
            follow: false,
            since: None,
            until: None,
            level: None,
            target: None,
            path: false,
            source: LogSourceArg::Runtime,
            pid_file: None,
        }
    }

    fn build(args: LogsArgs) -> Result<LogQuery> {
        LogQuery::build(LogComponent::Agent, &args)
    }

    #[test]
    fn the_default_tail_is_one_hundred() {
        assert_eq!(build(args()).unwrap().tail, DEFAULT_TAIL);
    }

    #[test]
    fn zero_and_explicit_tails_are_preserved() {
        let mut options = args();
        options.tail = Some(0);
        assert_eq!(build(options).unwrap().tail, 0);
        let mut options = args();
        options.tail = Some(500);
        assert_eq!(build(options).unwrap().tail, 500);
    }

    #[test]
    fn durations_are_relative_to_now() {
        let now = Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0).unwrap();
        assert_eq!(
            parse_since("30m", now).unwrap(),
            now - Duration::minutes(30)
        );
        assert_eq!(
            parse_since("1h30m", now).unwrap(),
            now - Duration::minutes(90)
        );
        assert_eq!(parse_since("2d", now).unwrap(), now - Duration::days(2));
    }

    #[test]
    fn rfc3339_offsets_are_normalised_to_utc() {
        let now = Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0).unwrap();
        assert_eq!(
            parse_since("2026-11-26T14:00:00+02:00", now).unwrap(),
            Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0).unwrap()
        );
    }

    #[test]
    fn an_invalid_since_is_rejected() {
        let now = Utc::now();
        for value in ["yesterday", "3w", "10"] {
            let error = parse_since(value, now).unwrap_err();
            assert!(
                format!("{error:#}").contains("duration"),
                "{value}: {error:#}"
            );
        }
    }

    #[test]
    fn until_must_be_absolute() {
        let mut options = args();
        options.until = Some("30m".to_string());
        let error = build(options).unwrap_err();
        assert!(
            format!("{error:#}").contains("RFC3339"),
            "a duration is not a valid --until: {error:#}"
        );
    }

    #[test]
    fn an_inverted_range_is_rejected() {
        let mut options = args();
        options.since = Some("2026-11-26T13:00:00Z".to_string());
        options.until = Some("2026-11-26T12:00:00Z".to_string());
        let error = build(options).unwrap_err();
        assert!(format!("{error:#}").contains("after"), "{error:#}");
    }

    #[test]
    fn raw_sources_reject_parsed_filters() {
        for source in [LogSourceArg::Startup, LogSourceArg::Service] {
            let mut options = args();
            options.source = source;
            options.level = Some(LogLevelArg::Warn);
            let error = build(options).unwrap_err();
            assert!(format!("{error:#}").contains("--level"), "{error:#}");

            let mut options = args();
            options.source = source;
            options.target = Some("nession_agent::ws".to_string());
            let error = build(options).unwrap_err();
            assert!(format!("{error:#}").contains("--target"), "{error:#}");
        }
    }

    #[test]
    fn the_server_has_no_service_source() {
        let mut options = args();
        options.source = LogSourceArg::Service;
        let error = LogQuery::build(LogComponent::Server, &options).unwrap_err();
        assert!(format!("{error:#}").contains("unsupported"), "{error:#}");
    }

    #[test]
    fn path_only_rejects_content_options() {
        for mutate in [
            (|options: &mut LogsArgs| options.follow = true) as fn(&mut LogsArgs),
            |options: &mut LogsArgs| options.tail = Some(10),
            |options: &mut LogsArgs| options.since = Some("1h".to_string()),
            |options: &mut LogsArgs| options.until = Some("2026-11-26T12:00:00Z".to_string()),
            |options: &mut LogsArgs| options.level = Some(LogLevelArg::Info),
            |options: &mut LogsArgs| options.target = Some("t".to_string()),
        ] {
            let mut options = args();
            options.path = true;
            mutate(&mut options);
            assert!(
                build(options).is_err(),
                "must reject --path with content options"
            );
        }
    }

    #[test]
    fn an_empty_target_is_rejected() {
        let mut options = args();
        options.target = Some("   ".to_string());
        assert!(build(options).is_err());
    }

    #[test]
    fn target_matching_requires_a_module_boundary() {
        let query = LogQuery {
            component: LogComponent::Agent,
            source: LogSource::Runtime,
            tail: 10,
            follow: false,
            since: None,
            until: None,
            level: None,
            target: Some("nession_agent::ws".to_string()),
            path_only: false,
        };
        let header = |target: &str| crate::local_logs::format::RecordHeader {
            timestamp: None,
            level: None,
            target: Some(target.to_string()),
        };
        assert!(query.matches(&header("nession_agent::ws")));
        assert!(query.matches(&header("nession_agent::ws::relay")));
        assert!(!query.matches(&header("nession_agent::wss")));
        assert!(!query.matches(&header("other::ws")));
    }
}
