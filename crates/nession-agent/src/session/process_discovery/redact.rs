//! Command-line sanitization for the Agent→Server hop (#2514).
//!
//! A command line is the highest-risk field in a process snapshot: arguments
//! routinely carry tokens, passwords and URL userinfo. This module redacts
//! **before** the snapshot leaves the Agent, so no consumer, log or transport
//! ever holds the raw value. It also bounds the display so a pathological argv
//! cannot inflate a response.
//!
//! The rules are deliberately conservative and recognizable:
//!
//! - a flag whose name names a secret takes the next argument as its value;
//! - `--name=value` with a secret-bearing name loses the value;
//! - URL userinfo (`scheme://user:pass@host`) loses the userinfo;
//! - `Bearer …` and `Authorization: …` lose everything after the credential
//!   marker, wherever they appear in one argument;
//! - an environment-style `SECRET_KEY=value` argument loses the value.
//!
//! The environment is never read at all: the macOS command reader stops at
//! `argc`, so there is nothing to leak from there even by accident.

/// Normalized (lowercase, `-` → `_`) key parts that mark a value as a secret.
const SENSITIVE_PARTS: [&str; 15] = [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "api_key",
    "apikey",
    "access_key",
    "accesskey",
    "private_key",
    "privatekey",
    "credential",
    "authorization",
    "auth_token",
    "session_key",
];

/// A whole key that is sensitive even though it is not a substring match.
const SENSITIVE_KEYS: [&str; 2] = ["auth", "credentials"];

/// Sanitize one argv into a bounded display string.
///
/// Returns `(display, redacted, truncated)`. `redacted` says at least one value
/// was replaced; `truncated` says the display was cut to a bound. The two are
/// distinct because "we hid something" and "we did not show everything" are
/// different claims.
pub(super) fn sanitize(argv: &[String], max_bytes: usize, max_args: usize) -> (String, bool, bool) {
    let mut redacted_any = false;
    let mut truncated = argv.len() > max_args;
    let mut pieces = Vec::new();
    let mut expect_value = false;

    for arg in argv.iter().take(max_args) {
        let (sanitized, redacted) = sanitize_arg(arg, expect_value);
        redacted_any |= redacted;
        // A flag that names a secret consumes the next argument only when that
        // argument does not itself look like a flag.
        expect_value = is_sensitive_flag(arg) && !arg.contains('=');
        pieces.push(shell_word(&sanitized));
    }

    let mut display = pieces.join(" ");
    if display.len() > max_bytes {
        display = bound(&display, max_bytes);
        truncated = true;
    }
    (display, redacted_any, truncated)
}

/// Redact one argument, given whether the previous argument asked for a secret.
fn sanitize_arg(arg: &str, expect_value: bool) -> (String, bool) {
    if expect_value && !arg.starts_with('-') {
        return ("[REDACTED]".to_string(), true);
    }

    // `--name=value` / `NAME=value`: only the value is replaced.
    if let Some((key, value)) = split_assignment(arg) {
        if is_sensitive_key(key) && !value.is_empty() {
            return (format!("{key}=[REDACTED]"), true);
        }
        let (value, redacted) = redact_inline(value);
        return (format!("{key}={value}"), redacted);
    }

    let (sanitized, redacted) = redact_inline(arg);
    (sanitized, redacted)
}

/// Replace credential-shaped substrings inside one argument.
fn redact_inline(arg: &str) -> (String, bool) {
    let mut out = arg.to_string();
    let mut redacted = false;

    if let Some(rest) = redact_url_userinfo(&out) {
        out = rest;
        redacted = true;
    }
    if let Some(rest) = redact_query_params(&out) {
        out = rest;
        redacted = true;
    }
    // The authorization header subsumes any `Bearer` inside it, so it runs
    // first; the surviving text then has no marker left to find.
    if let Some(rest) = redact_after_marker(&out, "authorization:") {
        out = rest;
        redacted = true;
    }
    if let Some(rest) = redact_after_marker(&out, "bearer ") {
        out = rest;
        redacted = true;
    }
    if let Some(rest) = redact_after_marker(&out, "password=") {
        out = rest;
        redacted = true;
    }
    (out, redacted)
}

/// Redact sensitive query parameters (`?token=…`, `&api_key=…`).
fn redact_query_params(arg: &str) -> Option<String> {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    let mut changed = false;
    loop {
        let Some(pos) = rest.find(['?', '&']) else {
            out.push_str(rest);
            break;
        };
        let (Some(head), Some(separator)) = (
            rest.get(..pos),
            rest.get(pos..).and_then(|tail| tail.chars().next()),
        ) else {
            out.push_str(rest);
            break;
        };
        out.push_str(head);
        out.push(separator);
        let Some(tail) = rest.get(pos + separator.len_utf8()..) else {
            break;
        };
        let end = tail.find(['&', '#']).unwrap_or(tail.len());
        let segment = tail.get(..end).unwrap_or(tail);
        if let Some((key, _)) = segment.split_once('=') {
            if is_sensitive_key(key) {
                out.push_str(key);
                out.push_str("=[REDACTED]");
                changed = true;
            } else {
                out.push_str(segment);
            }
        } else {
            out.push_str(segment);
        }
        rest = tail.get(end..).unwrap_or("");
        if rest.is_empty() {
            break;
        }
    }
    changed.then_some(out)
}

/// `scheme://user:password@host` → `scheme://[REDACTED]@host`.
///
/// The userinfo ends at the first `@` before the first `/` after the scheme;
/// an `@` in the path does not count.
fn redact_url_userinfo(arg: &str) -> Option<String> {
    let scheme = arg.find("://")?;
    let after_scheme = scheme + 3;
    let rest = &arg[after_scheme..];
    let end_of_authority = rest.find('/').unwrap_or(rest.len());
    let at = rest[..end_of_authority].find('@')?;
    if at == 0 {
        return None;
    }
    Some(format!("{}[REDACTED]{}", &arg[..after_scheme], &rest[at..]))
}

/// Keep everything up to the marker (inclusive) and replace the rest.
fn redact_after_marker(arg: &str, marker: &str) -> Option<String> {
    let lower = arg.to_ascii_lowercase();
    let at = lower.find(marker)?;
    let end = at + marker.len();
    let tail = &arg[end..];
    if tail.trim().is_empty() {
        return None;
    }
    // Keep the separator that made the value readable (`Bearer x` →
    // `Bearer [REDACTED]`, `Authorization: x` → `Authorization: [REDACTED]`).
    let whitespace = tail.len() - tail.trim_start().len();
    Some(format!("{}[REDACTED]", &arg[..end + whitespace]))
}

/// Split `key=value` at the first `=`, when the key looks like a name.
fn split_assignment(arg: &str) -> Option<(&str, &str)> {
    let (key, value) = arg.split_once('=')?;
    let bare = key.trim_start_matches('-');
    if bare.is_empty() || bare.contains('/') || bare.contains(' ') {
        return None;
    }
    Some((key, value))
}

/// Whether a flag's own name asks for a secret value.
fn is_sensitive_flag(arg: &str) -> bool {
    let Some(name) = arg.strip_prefix('-') else {
        return false;
    };
    let name = name.trim_start_matches('-');
    if name.is_empty() || name.contains('=') {
        return false;
    }
    is_sensitive_key(name)
}

/// Whether a key names a secret.
fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace('-', "_");
    if normalized.is_empty() {
        return false;
    }
    if SENSITIVE_KEYS.contains(&normalized.as_str()) {
        return true;
    }
    SENSITIVE_PARTS.iter().any(|part| {
        normalized == *part
            || normalized.starts_with(&format!("{part}_"))
            || normalized.ends_with(&format!("_{part}"))
            || normalized.contains(&format!("_{part}_"))
    })
}

/// Quote one display word only when it would otherwise be ambiguous.
///
/// This is a **display**, not a shell command: quoting everything shell-special
/// would turn `https://…?x=1` into noise. Whitespace, quotes and emptiness are
/// the cases where joining without quoting would misrepresent one argument as
/// two.
fn shell_word(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c == '\'' || c == '"')
    {
        return value.to_string();
    }
    let escaped = value.replace('\'', r"'\''");
    format!("'{escaped}'")
}

/// Cut a string at a UTF-8 boundary of at most `max` bytes.
pub(super) fn bound(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn a_secret_flag_takes_the_next_argument_as_its_value() {
        let (display, redacted, _) = sanitize(
            &args(&["tool", "--token", "sk-live-123", "--verbose"]),
            512,
            32,
        );
        assert_eq!(display, "tool --token [REDACTED] --verbose");
        assert!(redacted);
    }

    #[test]
    fn a_secret_in_an_assignment_flag_is_redacted_but_the_flag_stays_readable() {
        for case in [
            ("--password=hunter2", "--password=[REDACTED]"),
            ("--api-key=abc", "--api-key=[REDACTED]"),
            ("API_TOKEN=xyz", "API_TOKEN=[REDACTED]"),
            ("--client-secret=shh", "--client-secret=[REDACTED]"),
        ] {
            let (display, redacted, _) = sanitize(&args(&[case.0]), 512, 32);
            assert_eq!(display, case.1, "input {case:?}");
            assert!(redacted, "input {case:?}");
        }
    }

    #[test]
    fn an_ordinary_flag_that_merely_starts_with_auth_is_not_redacted() {
        let (display, redacted, _) = sanitize(&args(&["git", "--author", "Ada"]), 512, 32);
        assert_eq!(display, "git --author Ada");
        assert!(!redacted);
    }

    #[test]
    fn url_userinfo_is_removed_before_the_agent_server_hop() {
        let (display, redacted, _) = sanitize(
            &args(&["curl", "https://user:pass@example.test/path?x=1"]),
            512,
            32,
        );
        assert_eq!(display, "curl https://[REDACTED]@example.test/path?x=1");
        assert!(redacted);
    }

    #[test]
    fn bearer_material_is_removed_wherever_it_appears() {
        let (display, redacted, _) = sanitize(
            &args(&["curl", "-H", "Authorization: Bearer abc.def"]),
            512,
            32,
        );
        assert_eq!(display, "curl -H 'Authorization: [REDACTED]'");
        assert!(redacted);
    }

    #[test]
    fn an_at_sign_in_a_path_is_not_userinfo() {
        let (display, redacted, _) = sanitize(&args(&["mail", "user@example.test"]), 512, 32);
        assert_eq!(display, "mail user@example.test");
        assert!(!redacted);
    }

    #[test]
    fn display_is_bounded_and_says_so() {
        let args = args(&["tool", &"x".repeat(600)]);
        let (display, _, truncated) = sanitize(&args, 64, 32);
        assert!(display.len() <= 64);
        assert!(truncated);
    }

    #[test]
    fn too_many_arguments_says_so() {
        let args = args(&["tool", "a", "b", "c"]);
        let (_, _, truncated) = sanitize(&args, 512, 2);
        assert!(truncated);
    }

    #[test]
    fn a_value_that_needs_quoting_is_quoted_for_display() {
        let (display, _, _) = sanitize(&args(&["echo", "hello world"]), 512, 32);
        assert_eq!(display, "echo 'hello world'");
    }
}
