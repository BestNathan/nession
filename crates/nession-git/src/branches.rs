//! Local branches and where each one stands (#846).
//!
//! Read-only, like everything else here.
//!
//! ## Why this is `for-each-ref` and not `git branch`
//!
//! Both answer the question. Only one of them *cannot* do anything else:
//! `git branch -D` deletes a branch, and it reaches `cmd.rs`'s guard with the
//! same first argument as `git branch --list`. That guard matches on the
//! subcommand name, so it cannot tell them apart — see `cmd.rs` on why the
//! answer was to stop needing it to, rather than to teach it two spellings.
//! `for-each-ref` has no write form at all, and it is what git documents for
//! reading refs from a script.
//!
//! ## What a branch listing is for
//!
//! The Workspace header already answers *"what is the current branch and how
//! far is it from its upstream"*. It cannot answer *"what other branches exist,
//! and how does each stand against its own upstream"* — it does not know the
//! others are there. That is this listing's whole content, which is why the
//! current branch is marked rather than omitted: it is the anchor the other
//! rows are read against, not a second copy of the header.
//!
//! The one actionable fact it adds is **which branches carry unpushed work**,
//! which is a real question for a Session on a machine the user is not sitting
//! at.

use serde::Serialize;

use crate::cmd::GitCmd;
use crate::security::{DEFAULT_BRANCH_LIMIT, MAX_BRANCH_BYTES, MAX_BRANCH_LIMIT};

const FIELD_SEP: char = '\u{1f}';
const RECORD_SEP: char = '\u{1e}';

/// Four fields per branch, then a record separator.
///
/// `%(HEAD)` is `*` on the current branch and a space on every other, which is
/// why the current marker costs no second command.
const FORMAT: &str =
    "--format=%(HEAD)\x1f%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track)\x1e";

/// One local branch.
///
/// `camelCase` for the reason `ChangedFile` records: the client reads camelCase,
/// and a multi-word field without the rule arrives as `undefined` with nothing
/// to say so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    /// HEAD points here.
    pub current: bool,
    /// The configured upstream, `None` when the branch has none. Still set when
    /// the upstream has been deleted — that is what `upstream_gone` reports.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits this branch has that its upstream does not.
    pub ahead: u32,
    /// Commits the upstream has that this branch does not.
    pub behind: u32,
    /// The configured upstream no longer exists — git's `[gone]`.
    pub upstream_gone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub branches: Vec<Branch>,
    /// The count that was answered for, so the view can offer "more" honestly.
    pub limit: usize,
    pub truncated_bytes: usize,
    pub truncated: bool,
}

/// Local branches, current first.
///
/// `--sort=-HEAD` is what puts the current branch at the top *inside git's own
/// output*, which matters because `--count` then bounds the work without ever
/// being able to cut the current branch off the end — a bound that could hide
/// where you are would be worse than no bound.
pub async fn branches(cmd: &GitCmd, limit: Option<usize>) -> anyhow::Result<Branches> {
    let limit = limit
        .unwrap_or(DEFAULT_BRANCH_LIMIT)
        .clamp(1, MAX_BRANCH_LIMIT);
    let count = format!("--count={limit}");

    let out = cmd
        .run(
            &[
                "for-each-ref",
                "--sort=-HEAD",
                &count,
                FORMAT,
                "refs/heads/",
            ],
            MAX_BRANCH_BYTES,
        )
        .await?;

    Ok(Branches {
        branches: parse(&out.stdout),
        limit,
        truncated_bytes: out.truncated_bytes,
        truncated: out.truncated(),
    })
}

/// Parse the `for-each-ref` stream.
///
/// A record that runs out of fields is dropped rather than half-read, the same
/// rule `log` uses: a branch with no name is not a branch, and inventing one
/// from a partial line would put a row on screen that names nothing.
fn parse(bytes: &[u8]) -> Vec<Branch> {
    let text = String::from_utf8_lossy(bytes);
    text.split(RECORD_SEP)
        .filter_map(|record| {
            let record = record.trim_matches('\n');
            if record.is_empty() {
                return None;
            }
            let mut fields = record.split(FIELD_SEP);
            let head = fields.next()?;
            let name = fields.next()?;
            let upstream = fields.next()?;
            let track = fields.next()?;
            if name.is_empty() {
                return None;
            }

            let upstream = if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            };
            let (ahead, behind, upstream_gone) = parse_track(track);

            Some(Branch {
                name: name.to_string(),
                current: head.trim() == "*",
                upstream,
                ahead,
                behind,
                upstream_gone,
            })
        })
        .collect()
}

/// `%(upstream:track)` in the six shapes git emits under `LC_ALL=C`.
///
/// Measured, because two of them are the same string:
///
/// ```text
/// [ahead 1]                ahead
/// [behind 1]               behind
/// [ahead 1, behind 1]      diverged
/// ""                       up to date      (upstream is set)
/// ""                       no upstream     (upstream is empty)
/// [gone]                   upstream deleted
/// ```
///
/// The empty case is why this cannot answer on its own: "in sync" and "tracks
/// nothing" are different sentences on screen and identical here, so the caller
/// reads `%(upstream:short)` to tell them apart. Only the counts and the gone
/// flag come from this string.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let inner = track.trim();
    let inner = inner
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(inner);

    if inner == "gone" {
        return (0, 0, true);
    }

    let mut ahead = 0;
    let mut behind = 0;
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One NUL-style stream: records joined by the record separator, with the
    /// trailing separator git also emits. Each record literal is
    /// `head \x1f name \x1f upstream \x1f track`.
    fn stream(records: &[&str]) -> Vec<u8> {
        let sep = RECORD_SEP.to_string();
        format!("{}{sep}", records.join(&sep)).into_bytes()
    }

    #[test]
    fn reads_the_current_marker_and_the_name() {
        let out = parse(&stream(&["*\x1fmain\x1forigin/main\x1f"]));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "main");
        assert!(out[0].current);
        assert_eq!(out[0].upstream.as_deref(), Some("origin/main"));
    }

    #[test]
    fn a_non_current_branch_is_not_marked() {
        // `%(HEAD)` is a single space for every branch that is not HEAD, so a
        // parser that tested for non-empty would mark all of them.
        let out = parse(&stream(&[" \x1ffeat/x\x1f\x1f"]));
        assert!(!out[0].current);
    }

    #[test]
    fn reads_each_track_shape_git_emits() {
        let cases = [
            ("[ahead 3]", 3, 0, false),
            ("[behind 2]", 0, 2, false),
            ("[ahead 1, behind 4]", 1, 4, false),
            ("[gone]", 0, 0, true),
        ];
        for (track, ahead, behind, gone) in cases {
            let record = format!(" \x1ffeat/x\x1forigin/feat\x1f{track}");
            let out = parse(&stream(&[&record]));
            assert_eq!(
                (out[0].ahead, out[0].behind, out[0].upstream_gone),
                (ahead, behind, gone),
                "for track {track:?}"
            );
        }
    }

    #[test]
    fn an_empty_track_is_in_sync_when_there_is_an_upstream() {
        // The case that makes this parser's output insufficient on its own: an
        // empty track is also what a branch with no upstream has, and the two
        // read differently on screen. `upstream` is the tiebreaker the view uses.
        let out = parse(&stream(&[" \x1fmain\x1forigin/main\x1f"]));
        assert_eq!((out[0].ahead, out[0].behind), (0, 0));
        assert!(!out[0].upstream_gone);
        assert_eq!(out[0].upstream.as_deref(), Some("origin/main"));
    }

    #[test]
    fn a_branch_with_no_upstream_has_none() {
        let out = parse(&stream(&[" \x1flocal-only\x1f\x1f"]));
        assert_eq!(out[0].upstream, None);
        assert_eq!((out[0].ahead, out[0].behind), (0, 0));
    }

    #[test]
    fn a_gone_upstream_keeps_its_name() {
        // git leaves the configured ref in place when the remote branch is
        // deleted, and saying *which* ref went away is the useful half.
        let out = parse(&stream(&[" \x1ffeat/x\x1forigin/feat/x\x1f[gone]"]));
        assert!(out[0].upstream_gone);
        assert_eq!(out[0].upstream.as_deref(), Some("origin/feat/x"));
    }

    #[test]
    fn a_record_that_runs_out_of_fields_is_dropped_not_half_read() {
        let out = parse(&stream(&["*\x1fmain\x1forigin/main\x1f", " \x1ftruncated"]));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "main");
    }

    #[test]
    fn an_empty_answer_is_an_empty_list() {
        // A repository with no commits yet has no branches, which is a state,
        // not a parse failure.
        assert!(parse(b"").is_empty());
    }

    #[test]
    fn a_branch_serialises_in_the_spelling_the_client_reads() {
        let branch = Branch {
            name: "feat/x".to_string(),
            current: false,
            upstream: Some("origin/feat/x".to_string()),
            ahead: 1,
            behind: 0,
            upstream_gone: true,
        };
        let json = serde_json::to_value(&branch).unwrap();
        assert_eq!(json["upstreamGone"], true);
        assert!(
            json.get("upstream_gone").is_none(),
            "the snake_case key must not be on the wire at all, got: {json}"
        );
    }

    #[test]
    fn an_absent_upstream_is_omitted_rather_than_null() {
        let branch = Branch {
            name: "local".to_string(),
            current: true,
            upstream: None,
            ahead: 0,
            behind: 0,
            upstream_gone: false,
        };
        let json = serde_json::to_value(&branch).unwrap();
        assert!(json.get("upstream").is_none());
        assert!(json.get("upstream_gone").is_none());
        assert_eq!(json["upstreamGone"], false);
    }
}
