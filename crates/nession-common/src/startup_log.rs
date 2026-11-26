//! Bounded, owner-private startup diagnostics.
//!
//! A daemon can fail before its runtime log writer exists: an unreadable or
//! malformed configuration file, an invalid effective value, an unwritable log
//! directory, or a readiness deadline the parent enforces. Those failures used
//! to exist only on a terminal (foreground) or in a captured stderr pipe
//! (background). This module gives them one durable, bounded home that
//! `nession agent|server logs --source startup` reads (#4600).
//!
//! # Contract
//!
//! - Location: `<home>/<component>/logs/startup/startup.log` with rotated
//!   siblings `startup.log.1`, `startup.log.2` (oldest last).
//! - Retention: at most [`RETENTION_FILES`] files, each kept strictly below
//!   [`MAX_FILE_BYTES`] (rotation starts before a record would cross it). A record that would cross the size cap rotates
//!   first, so the directory is bounded independently of the runtime writer's
//!   own daily/hourly retention.
//! - A single record is truncated to [`MAX_RECORD_BYTES`].
//! - Files are created `0600` inside a `0700` directory on Unix.
//! - Records are one line: `<RFC3339 UTC> <component> <phase>: <message>`.
//!
//! Callers pass diagnostic *sentences*, never config/env dumps, tokens or
//! signed URLs. [`sanitize`] is a last line of defence: it strips ANSI/control
//! bytes, redacts common secret assignments and URL query strings, and
//! truncates the result.
//!
//! A logging-path failure cannot be reported into the directory that failed.
//! [`record`] returns the I/O error and callers keep the terminal/stderr
//! diagnostic and state that startup capture was unavailable.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::logging::LogComponent;

/// The current (newest) startup diagnostics filename.
pub const STARTUP_LOG_FILE: &str = "startup.log";

/// Total startup diagnostics files retained (`startup.log`, `.1`, `.2`).
pub const RETENTION_FILES: usize = 3;

/// Maximum bytes in one startup diagnostics file.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;

/// Maximum bytes of one startup record (after sanitisation).
pub const MAX_RECORD_BYTES: usize = 4 * 1024;

/// Append one startup diagnostic record under the process's effective home.
///
/// Returns the file the record was written to. The error is returned rather
/// than swallowed so a caller can say startup capture was unavailable; the
/// caller must still preserve its terminal/stderr diagnostic.
pub fn record(component: LogComponent, phase: &str, message: &str) -> io::Result<PathBuf> {
    let dir = component.startup_dir()?;
    record_in(&dir, component, phase, message)
}

/// Append one startup diagnostic record under an explicit startup directory.
pub fn record_in(
    dir: &Path,
    component: LogComponent,
    phase: &str,
    message: &str,
) -> io::Result<PathBuf> {
    ensure_private_dir(dir)?;
    let path = dir.join(STARTUP_LOG_FILE);
    rotate_if_needed(dir, &path)?;

    let mut line = format!(
        "{} {} {}: {}\n",
        Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"),
        component.as_str(),
        sanitize_phase(phase),
        sanitize(message)
    );
    if line.len() > MAX_RECORD_BYTES {
        line.truncate(floor_char_boundary(
            &line,
            MAX_RECORD_BYTES.saturating_sub(1),
        ));
        line.push('\n');
    }

    let mut file = private_append(&path)?;
    file.write_all(line.as_bytes())?;
    file.flush()?;
    Ok(path)
}

/// Record a startup diagnostic and return a one-line outcome to attach to the
/// caller's terminal/stderr diagnostic.
///
/// Never panics and never hides the original error: when the capture location
/// itself is unusable (for example the log directory that failed to build),
/// the returned sentence says so and the caller still reports its own error.
pub fn record_or_note(component: LogComponent, phase: &str, message: &str) -> String {
    note_from_result(record(component, phase, message))
}

fn note_from_result(result: io::Result<PathBuf>) -> String {
    match result {
        Ok(path) => format!("startup diagnostics: {}", path.display()),
        Err(error) => format!("startup diagnostics unavailable: {error}"),
    }
}

/// The startup diagnostics files for `dir`, oldest first.
///
/// Missing directory means no history (`Ok(empty)`); an unreadable directory
/// or entry is an error so the caller can distinguish absence from a
/// permissions/I/O failure.
pub fn startup_log_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut rotated = Vec::new();
    let mut current = None;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let index = match name.as_str() {
            STARTUP_LOG_FILE => {
                current = Some(entry.path());
                continue;
            }
            _ => match name.strip_prefix("startup.log.") {
                Some(suffix) => match suffix.parse::<usize>() {
                    Ok(index) => index,
                    Err(_) => continue,
                },
                None => continue,
            },
        };
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.file_type().is_file() {
            continue;
        }
        rotated.push((index, entry.path()));
    }
    rotated.sort_by_key(|(index, _)| std::cmp::Reverse(*index));
    let mut files: Vec<PathBuf> = rotated.into_iter().map(|(_, path)| path).collect();
    if let Some(current) = current {
        files.push(current);
    }
    Ok(files)
}

/// Redact and normalise one diagnostic sentence.
///
/// The output is single-line UTF-8, contains no ANSI escape sequences or
/// control characters, redacts `key=value` / `key: value` assignments for
/// token/password/secret-like keys, and replaces URL query strings (where
/// signed tokens live) with `<redacted>`. It is not a substitute for callers
/// avoiding sensitive payloads in the first place.
pub fn sanitize(message: &str) -> String {
    let text: String = strip_ansi(message)
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let text = redact_secret_assignments(&text);
    let text = redact_url_queries(&text);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&text, MAX_RECORD_BYTES)
}

/// Replace the query string of every URL in `text` with `?<redacted>`.
///
/// Signed URLs keep their authority and path (useful for diagnosing which
/// endpoint failed) and lose everything after the first `?`.
fn redact_url_queries(text: &str) -> String {
    const SCHEMES: [&str; 4] = ["https://", "http://", "wss://", "ws://"];
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let lower = rest.to_ascii_lowercase();
        let next = SCHEMES
            .iter()
            .filter_map(|scheme| lower.find(scheme).map(|index| (index, scheme.len())))
            .min_by_key(|(index, _)| *index);
        let Some((start, scheme_len)) = next else {
            output.push_str(rest);
            break;
        };
        let url_start = start + scheme_len;
        let tail = &rest[url_start..];
        let url_end = tail.find(char::is_whitespace).unwrap_or(tail.len());
        let url = &tail[..url_end];
        match url.find('?') {
            Some(query) => {
                output.push_str(&rest[..url_start]);
                output.push_str(&url[..query]);
                output.push_str("?<redacted>");
                rest = &tail[url_end..];
            }
            None => {
                output.push_str(&rest[..url_start]);
                rest = &rest[url_start..];
            }
        }
    }
    output
}

fn sanitize_phase(phase: &str) -> String {
    let phase: String = phase
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if phase.is_empty() {
        "startup".to_string()
    } else {
        phase
    }
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            // CSI: ESC '[' ... final byte in 0x40..=0x7E.
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

/// Replace secret assignments in the full text, including a quoted value that
/// is separated from its key by whitespace.
fn redact_secret_assignments(text: &str) -> String {
    const KEYS: [&str; 7] = [
        "auth_token",
        "access_token",
        "authorization",
        "password",
        "secret",
        "bearer",
        "token",
    ];
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let found = find_next_secret_assignment(rest, &KEYS);
        let Some((_start, after_key, whitespace)) = found else {
            output.push_str(rest);
            break;
        };
        let separator_end = after_key + whitespace + 1;
        output.push_str(&rest[..separator_end]);
        let after_separator = &rest[separator_end..];
        let value_trimmed = after_separator.trim_start();
        output.push_str(&after_separator[..after_separator.len() - value_trimmed.len()]);
        let value_end = match value_trimmed.chars().next() {
            Some(quote @ ('"' | '\'')) => {
                let closing = value_trimmed
                    .get(1..)
                    .and_then(|value| value.find(quote))
                    .map(|index| index + 1);
                match closing {
                    Some(index) => index + 1,
                    None => value_trimmed.len(),
                }
            }
            _ => value_trimmed
                .find(char::is_whitespace)
                .unwrap_or(value_trimmed.len()),
        };
        output.push_str("<redacted>");
        rest = &value_trimmed[value_end..];
    }
    output
}

/// The earliest secret assignment in `text`, as (key start, key end,
/// whitespace between the separator and the value).
fn find_next_secret_assignment(text: &str, keys: &[&str]) -> Option<(usize, usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let mut earliest: Option<(usize, usize, usize)> = None;
    for key in keys {
        let mut search_from = 0;
        while let Some(offset) = lower.get(search_from..).and_then(|value| value.find(key)) {
            let start = search_from + offset;
            let boundary = start == 0
                || !(lower
                    .as_bytes()
                    .get(start - 1)
                    .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_'));
            let after_key = start + key.len();
            if boundary {
                let after = &text[after_key..];
                let trimmed = after.trim_start();
                if trimmed.starts_with('=') || trimmed.starts_with(':') {
                    if earliest.is_none_or(|(current, _, _)| start < current) {
                        earliest = Some((start, after_key, after.len() - trimmed.len()));
                    }
                    break;
                }
            }
            search_from = after_key;
        }
    }
    earliest
}

fn truncate_chars(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let end = floor_char_boundary(text, max_bytes.saturating_sub(3));
    format!("{}...", &text[..end])
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(dir)?;
        if !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "startup diagnostics path {} is not a directory",
                    dir.display()
                ),
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn private_append(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Rotate before an append that would exceed [`MAX_FILE_BYTES`].
///
/// Rotation never renames a file this process does not own: only the exact
/// `startup.log`/`startup.log.N` names below `dir` participate. `startup.log`
/// becomes `.1`, each existing `.N` shifts to `.N+1`, and the oldest beyond
/// [`RETENTION_FILES`] is removed. A failed rotation returns its error instead
/// of silently growing the file.
fn rotate_if_needed(dir: &Path, path: &Path) -> io::Result<()> {
    let size = match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "startup diagnostics path {} is not a regular file",
                    path.display()
                ),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    // Rotate before a maximum-size record could cross the cap, so a file
    // never exceeds MAX_FILE_BYTES.
    if size.saturating_add(MAX_RECORD_BYTES as u64) <= MAX_FILE_BYTES {
        return Ok(());
    }
    let oldest = dir.join(format!("{STARTUP_LOG_FILE}.{}", RETENTION_FILES - 1));
    match fs::remove_file(&oldest) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    for index in (1..RETENTION_FILES - 1).rev() {
        let from = dir.join(format!("{STARTUP_LOG_FILE}.{index}"));
        let to = dir.join(format!("{STARTUP_LOG_FILE}.{}", index + 1));
        match fs::rename(&from, &to) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    fs::rename(path, dir.join(format!("{STARTUP_LOG_FILE}.1")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_is_sanitised_and_redacted() {
        let text = sanitize(
            "failed \u{1b}[31mload\u{1b}[0m token=abc123 auth_token: \"s3cr3t\" \
             url=wss://example.test/ws?access_token=leak",
        );
        assert!(!text.contains("abc123"), "{text}");
        assert!(!text.contains("s3cr3t"), "{text}");
        assert!(!text.contains("leak"), "{text}");
        assert!(!text.contains('\u{1b}'), "ANSI must not survive: {text:?}");
        assert!(text.contains("failed load"), "{text}");
        assert!(text.contains("wss://example.test/ws?<redacted>"), "{text}");
    }

    #[test]
    fn control_characters_collapse_to_one_line() {
        let text = sanitize("line one\nline\ttwo\r");
        assert!(!text.contains('\n') && !text.contains('\t'), "{text:?}");
    }

    #[test]
    fn an_oversized_record_is_truncated() {
        let text = sanitize(&"x".repeat(MAX_RECORD_BYTES * 2));
        assert!(text.len() <= MAX_RECORD_BYTES, "{}", text.len());
        assert!(text.ends_with("..."));
    }

    #[test]
    fn records_round_trip_through_startup_log_files() {
        let dir = tempfile::tempdir().unwrap();
        let startup = dir.path().join("startup");
        record_in(&startup, LogComponent::Agent, "config", "first").unwrap();
        record_in(&startup, LogComponent::Agent, "validate", "second").unwrap();

        let files = startup_log_files(&startup).unwrap();
        assert_eq!(files, vec![startup.join(STARTUP_LOG_FILE)]);
        let content = std::fs::read_to_string(&files[0]).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2, "{content}");
        assert!(lines[0].contains("agent config: first"), "{content}");
        assert!(lines[1].contains("agent validate: second"), "{content}");
    }

    #[test]
    fn rotation_keeps_a_bounded_number_of_files() {
        let dir = tempfile::tempdir().unwrap();
        let startup = dir.path().join("startup");
        fs::create_dir_all(&startup).unwrap();
        for index in 1..RETENTION_FILES {
            fs::write(
                startup.join(format!("{STARTUP_LOG_FILE}.{index}")),
                "x".repeat(usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX)),
            )
            .unwrap();
        }
        // Make `startup.log` full so the next record rotates.
        fs::write(
            startup.join(STARTUP_LOG_FILE),
            "y".repeat(usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX)),
        )
        .unwrap();

        record_in(&startup, LogComponent::Server, "startup", "rotates").unwrap();

        let mut names: Vec<String> = fs::read_dir(&startup)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "startup.log".to_string(),
                "startup.log.1".to_string(),
                "startup.log.2".to_string(),
            ]
        );
        let current = fs::read_to_string(startup.join(STARTUP_LOG_FILE)).unwrap();
        assert!(current.contains("rotates"), "{current}");
    }

    #[test]
    fn record_or_note_states_the_capture_outcome() {
        let written = note_from_result(Ok(PathBuf::from("/x/startup.log")));
        assert!(written.contains("/x/startup.log"), "{written}");

        let unavailable = note_from_result(Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "denied",
        )));
        assert!(
            unavailable.contains("startup diagnostics unavailable"),
            "{unavailable}"
        );
        assert!(unavailable.contains("denied"), "{unavailable}");
    }

    #[test]
    fn an_unrelated_file_is_not_listed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("startup.log.bak"), "x").unwrap();
        fs::write(dir.path().join("other"), "x").unwrap();
        assert!(startup_log_files(dir.path()).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let startup = dir.path().join("startup");
        record_in(&startup, LogComponent::Agent, "config", "private").unwrap();

        let mode = fs::metadata(startup.join(STARTUP_LOG_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
