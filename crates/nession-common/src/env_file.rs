//! `.env` file parsing.
//!
//! Supports the minimal `.env` grammar agreed for Nession v1:
//! - `KEY=VALUE` pairs
//! - `#` line comments and blank lines are ignored
//! - trailing comments are stripped only when the `#` is preceded by whitespace
//!   (`KEY=value # note` → `value`, but `KEY=va#lue` → `va#lue`)
//! - single- and double-quoted values; inside quotes `#` is always literal
//! - an optional `export ` prefix on the key is tolerated
//! - duplicate keys resolve last-occurrence-wins
//!
//! Malformed lines are skipped and reported as warnings rather than failing the
//! whole parse, so a single bad line never blocks session creation.

use serde::{Deserialize, Serialize};

/// Result of parsing a `.env` file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedEnv {
    /// Deduplicated variables. First-seen position is preserved; the value is
    /// the last occurrence for that key (last-wins).
    pub vars: Vec<(String, String)>,
    /// Human-readable warnings for skipped/malformed lines (1-based line refs).
    pub warnings: Vec<String>,
}

impl ParsedEnv {
    /// Number of resolved variables.
    #[must_use]
    pub fn len(&self) -> usize {
        self.vars.len()
    }

    /// True when no variables were resolved.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.vars.is_empty()
    }
}

/// Returns true when `key` is a valid environment variable name:
/// starts with a letter or underscore, followed by letters, digits, or
/// underscores.
fn is_valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Parse the value portion (everything after the first `=`).
///
/// Handles surrounding quotes and trailing ` #` comments per the grammar above.
fn parse_value(raw: &str) -> String {
    let trimmed = raw.trim_start();

    let first = trimmed.chars().next();
    if let Some(quote @ ('"' | '\'')) = first {
        // Find the matching closing quote. For double quotes, honour a small set
        // of escapes; single quotes are literal.
        let mut out = String::new();
        let mut chars = trimmed.chars().skip(1); // skip opening quote
        let mut closed = false;
        while let Some(c) = chars.next() {
            if quote == '"' && c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('r') => out.push('\r'),
                    Some('\\') => out.push('\\'),
                    Some('"') => out.push('"'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
                continue;
            }
            if c == quote {
                closed = true;
                break;
            }
            out.push(c);
        }
        if closed {
            return out;
        }
        // Unterminated quote: fall through and treat the raw (unquoted) rest as
        // the value so we don't silently drop data.
    }

    // Unquoted: a `#` preceded by whitespace begins a trailing comment.
    let mut end = trimmed.len();
    let mut prev_ws = false;
    for (i, c) in trimmed.char_indices() {
        if c == '#' && prev_ws {
            end = i;
            break;
        }
        prev_ws = c == ' ' || c == '\t';
    }
    trimmed.get(..end).unwrap_or(trimmed).trim_end().to_string()
}

/// Parse `.env` file content into deduplicated variables plus warnings.
#[must_use]
pub fn parse_env(content: &str) -> ParsedEnv {
    let mut vars: Vec<(String, String)> = Vec::new();
    // key -> index into `vars`, for last-wins dedup while preserving order.
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut warnings: Vec<String> = Vec::new();

    for (lineno, raw_line) in content.lines().enumerate() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((key_part, value_part)) = line.split_once('=') else {
            warnings.push(format!(
                "line {}: missing '=', skipped: {}",
                lineno + 1,
                trimmed
            ));
            continue;
        };

        // Tolerate an `export ` prefix.
        let key = key_part
            .trim()
            .strip_prefix("export ")
            .unwrap_or(key_part.trim())
            .trim();

        if !is_valid_key(key) {
            warnings.push(format!(
                "line {}: invalid key '{}', skipped",
                lineno + 1,
                key
            ));
            continue;
        }

        let value = parse_value(value_part);

        if let Some(slot) = index.get(key).and_then(|&i| vars.get_mut(i)) {
            slot.1 = value; // last-wins
        } else {
            index.insert(key.to_string(), vars.len());
            vars.push((key.to_string(), value));
        }
    }

    ParsedEnv { vars, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_pairs() {
        let p = parse_env("FOO=bar\nBAZ=qux\n");
        assert_eq!(
            p.vars,
            vec![("FOO".into(), "bar".into()), ("BAZ".into(), "qux".into())]
        );
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn comments_and_blanks_ignored() {
        let p = parse_env("# a comment\n\n  \nFOO=bar\n");
        assert_eq!(p.vars, vec![("FOO".into(), "bar".into())]);
    }

    #[test]
    fn empty_or_comment_only_is_empty() {
        assert!(parse_env("").is_empty());
        assert!(parse_env("# only comments\n\n").is_empty());
    }

    #[test]
    fn duplicate_key_last_wins() {
        let p = parse_env("FOO=1\nFOO=2\nFOO=3\n");
        assert_eq!(p.vars, vec![("FOO".into(), "3".into())]);
    }

    #[test]
    fn malformed_line_skipped_with_warning() {
        let p = parse_env("FOO=bar\nnotanassignment\nBAZ=qux\n");
        assert_eq!(p.vars.len(), 2);
        assert_eq!(p.warnings.len(), 1);
        assert!(p.warnings.first().is_some_and(|w| w.contains("line 2")));
    }

    #[test]
    fn invalid_key_skipped() {
        let p = parse_env("1FOO=bar\nGOOD=ok\nBAD KEY=x\n");
        assert_eq!(p.vars, vec![("GOOD".into(), "ok".into())]);
        assert_eq!(p.warnings.len(), 2);
    }

    #[test]
    fn trailing_comment_stripped_when_space_before_hash() {
        let p = parse_env("FOO=bar # trailing\n");
        assert_eq!(p.vars, vec![("FOO".into(), "bar".into())]);
    }

    #[test]
    fn hash_without_space_is_literal() {
        let p = parse_env("FOO=bar#baz\n");
        assert_eq!(p.vars, vec![("FOO".into(), "bar#baz".into())]);
    }

    #[test]
    fn double_quoted_value() {
        let p = parse_env("FOO=\"hello world # not a comment\"\n");
        assert_eq!(
            p.vars,
            vec![("FOO".into(), "hello world # not a comment".into())]
        );
    }

    #[test]
    fn single_quoted_value_is_literal() {
        let p = parse_env("FOO='a\\nb'\n");
        assert_eq!(p.vars, vec![("FOO".into(), "a\\nb".into())]);
    }

    #[test]
    fn double_quote_escapes() {
        let p = parse_env("FOO=\"line1\\nline2\\ttab\"\n");
        assert_eq!(p.vars, vec![("FOO".into(), "line1\nline2\ttab".into())]);
    }

    #[test]
    fn export_prefix_tolerated() {
        let p = parse_env("export FOO=bar\n");
        assert_eq!(p.vars, vec![("FOO".into(), "bar".into())]);
    }

    #[test]
    fn whitespace_around_equals() {
        let p = parse_env("FOO = bar\n");
        assert_eq!(p.vars, vec![("FOO".into(), "bar".into())]);
    }

    #[test]
    fn empty_value() {
        let p = parse_env("FOO=\n");
        assert_eq!(p.vars, vec![("FOO".into(), String::new())]);
    }
}
