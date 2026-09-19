//! Recent history, bounded (#826 §4: the Workspace surface carries History).
//!
//! Read-only, like everything else here — `git log` is the same kind of question
//! as `git status`, and #750's Non-Goals excluded it for scope, not for risk.
//! Nothing in this module writes.
//!
//! ## Why the format is machine-made rather than `--oneline`
//!
//! `--oneline` is for people: it joins the hash and the subject with a space, so
//! a parser has to guess where one ends — and a subject may contain anything,
//! including a space. This asks git for one record per commit with separators
//! that cannot appear in the fields: `%x1f` (unit separator) between fields and
//! `%x1e` (record separator) after each. A commit subject is a single line by
//! construction, so no field can forge a separator.
//!
//! ## Bounded twice, on purpose
//!
//! A count *and* a byte cap. The count is what the caller asked for and what
//! keeps a decade-old repository from returning a megabyte nobody scrolled to;
//! the byte cap is the backstop for the fields the count does not bound — author
//! names and encodings are arbitrary strings. Truncation is reported, never
//! silent: a history that quietly stops is indistinguishable from a repository
//! that quietly starts there.

use serde::Serialize;

use crate::cmd::GitCmd;
use crate::security::{MAX_LOG_BYTES, MAX_LOG_LIMIT};

/// Field and record separators, chosen so no field can contain them.
const FIELD_SEP: char = '\u{1f}';
const RECORD_SEP: char = '\u{1e}';

/// `camelCase` for the same reason `ChangedFile` is: the client reads camelCase,
/// and a field named `short_hash` would arrive as `undefined` with nothing to
/// say so.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Full object name.
    pub hash: String,
    /// Abbreviated, as git would print it.
    pub short_hash: String,
    pub author: String,
    /// git's own relative phrasing ("3 days ago"). Not re-derived here: the
    /// agent host's clock and the browser's are not the same clock, and a view
    /// that computed "3 days ago" from a timestamp would disagree with `git log`
    /// run in the Session beside it.
    pub relative_date: String,
    /// Committer date, ISO-8601 with the author's offset.
    pub date: String,
    /// First line of the commit message.
    pub subject: String,
    /// Decoration git would print — branch and tag names pointing here.
    pub refs: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub commits: Vec<Commit>,
    /// The count that was asked for, so the view can offer "more" honestly.
    pub limit: usize,
    /// Bytes the cap dropped. Non-zero means this is a prefix of the answer.
    pub truncated_bytes: usize,
    pub truncated: bool,
}

/// The `--format` string, kept beside the parser so the two cannot drift.
///
/// `%x1f` is emitted by git itself; writing a literal separator into the format
/// string would work too, but git would then also have to be trusted not to
/// escape it.
const FORMAT: &str = "--format=%H\x1f%h\x1f%an\x1f%ar\x1f%aI\x1f%s\x1f%D\x1e";

/// Recent commits on the current branch, newest first.
pub async fn history(cmd: &GitCmd, limit: Option<usize>) -> anyhow::Result<History> {
    let limit = limit
        .unwrap_or(crate::security::DEFAULT_LOG_LIMIT)
        .clamp(1, MAX_LOG_LIMIT);
    let max_count = format!("--max-count={limit}");

    // `--no-color` for the same reason the other commands pass it: a caller's
    // `color.ui = always` would put escape sequences inside a `%D` decoration.
    let out = cmd
        .run(&["log", "--no-color", &max_count, FORMAT], MAX_LOG_BYTES)
        .await?;

    let commits = parse(&out.stdout_string());

    Ok(History {
        commits,
        limit,
        truncated_bytes: out.truncated_bytes,
        truncated: out.truncated(),
    })
}

/// Parse the separator format. Split out so it can be tested against recorded
/// output, including the records that are *not* well formed.
fn parse(raw: &str) -> Vec<Commit> {
    raw.split(RECORD_SEP)
        .filter_map(|record| {
            // The last record is followed by the separator, so it is empty.
            let record = record.trim_start_matches('\n');
            if record.is_empty() {
                return None;
            }
            let mut fields = record.split(FIELD_SEP);
            let hash = fields.next()?;
            let short_hash = fields.next()?;
            let author = fields.next()?;
            let relative_date = fields.next()?;
            let date = fields.next()?;
            // A subject with a newline in it cannot happen — git takes the first
            // line — but a `%s` is not guaranteed present, so a record that runs
            // out here is dropped rather than half-read.
            let subject = fields.next()?;
            let refs = fields.next().unwrap_or("");

            Some(Commit {
                hash: hash.to_string(),
                short_hash: short_hash.to_string(),
                author: author.to_string(),
                relative_date: relative_date.to_string(),
                date: date.to_string(),
                subject: subject.to_string(),
                refs: refs.trim().to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_record_into_its_fields() {
        let raw = "abc123\x1fabc\x1fAda\x1f2 days ago\x1f2026-09-18T10:00:00+08:00\x1fAdd a thing\x1fHEAD -> main\x1e";
        let commits = parse(raw);

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].short_hash, "abc");
        assert_eq!(commits[0].author, "Ada");
        assert_eq!(commits[0].subject, "Add a thing");
        assert_eq!(commits[0].refs, "HEAD -> main");
    }

    #[test]
    fn a_subject_containing_the_human_separators_survives() {
        // The whole reason for `%x1f` rather than `--oneline`: a subject may
        // contain spaces, pipes, and anything else a person typed.
        let raw = "h\x1fh\x1fA\x1fnow\x1f2026-09-19T00:00:00Z\x1ffix: a | b — c (d)\x1f\x1e";
        let commits = parse(raw);

        assert_eq!(commits[0].subject, "fix: a | b — c (d)");
    }

    #[test]
    fn drops_a_record_that_runs_out_of_fields() {
        // A half-read commit is worse than a missing one: it would render with
        // an empty subject and look like a commit that had none.
        assert!(parse("abc\x1fabc\x1fAda\x1e").is_empty());
    }

    #[test]
    fn ignores_the_empty_record_after_the_final_separator() {
        let raw = "a\x1fa\x1fA\x1fnow\x1fT\x1fs\x1f\x1eb\x1fb\x1fB\x1fnow\x1fT\x1ft\x1f\x1e";
        assert_eq!(parse(raw).len(), 2);
    }
}
