//! The repository's worktrees (#846).
//!
//! Read-only. `git worktree list --porcelain` is the only form of that
//! subcommand this capability may run — see `cmd.rs`, where the name alone is
//! not enough to tell `list` from `add`.
//!
//! ## Identity versus inventory
//!
//! The Workspace header, and the Terminal Signal before it, already answer
//! *which checkout is this Session in* — one fact, one place. This listing
//! answers a different question the header cannot: *what other places does this
//! repository have*. The Session's own worktree is therefore **marked**, so the
//! two agree rather than compete.
//!
//! ## `prunable` is not decoration
//!
//! `git worktree remove` is not the only way a worktree goes away: deleting the
//! directory is enough, and git keeps the administrative entry until something
//! prunes it. Reporting that entry as an ordinary row would present a path that
//! no longer resolves as a place the user could go — the same "pretend it is
//! clean" failure `status.rs` refuses to make about a conflicted tree.

use std::path::Path;

use crate::protocol::worktrees::v1::{Worktree, Worktrees};
use crate::runtime::cmd::GitCmd;
use crate::runtime::security::MAX_WORKTREES_BYTES;

/// Every worktree of the repository the Session is in.
///
/// `root` is the work tree root the caller already resolved, used only to mark
/// the Session's own entry: the client could compare paths itself, but the
/// answer is a fact about *where the Session is*, which the agent knows and the
/// client would be inferring from a string it was handed.
pub async fn worktrees(cmd: &GitCmd, root: &Path) -> anyhow::Result<Worktrees> {
    let out = cmd
        .run(&["worktree", "list", "--porcelain"], MAX_WORKTREES_BYTES)
        .await?;

    Ok(Worktrees {
        worktrees: parse(&out.stdout, root),
        truncated_bytes: out.truncated_bytes,
        truncated: out.truncated(),
    })
}

/// Parse `--porcelain` blocks.
///
/// The format is one attribute per line, a blank line between entries, and an
/// attribute this version does not know is a line starting with a word it does
/// not recognise — skipped rather than fatal, the same rule `status.rs` applies,
/// so a future git adding one degrades to a missing detail instead of a broken
/// panel.
fn parse(bytes: &[u8], root: &Path) -> Vec<Worktree> {
    let text = String::from_utf8_lossy(bytes);
    let mut out: Vec<Worktree> = Vec::new();

    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }

        let (key, value) = match line.split_once(' ') {
            Some((key, value)) => (key, value),
            None => (line, ""),
        };

        match key {
            // Starts a new entry. Attributes only ever follow it, so an entry
            // is complete by the time the next one begins.
            "worktree" => out.push(Worktree {
                path: value.to_string(),
                branch: None,
                current: same_place(value, root),
                detached: false,
                bare: false,
                locked: None,
                prunable: None,
            }),
            _ => {
                let Some(entry) = out.last_mut() else {
                    // Attributes before any `worktree` line: nothing to attach
                    // them to, and inventing an entry would put a pathless row
                    // on screen.
                    continue;
                };
                match key {
                    "branch" => {
                        entry.branch = Some(
                            value
                                .strip_prefix("refs/heads/")
                                .unwrap_or(value)
                                .to_string(),
                        );
                    }
                    "detached" => entry.detached = true,
                    "bare" => entry.bare = true,
                    "locked" => entry.locked = Some(value.to_string()),
                    "prunable" => entry.prunable = Some(value.to_string()),
                    // `HEAD` and anything this version does not know.
                    _ => {}
                }
            }
        }
    }

    out
}

/// Whether a porcelain path names the same place as the resolved root.
///
/// Compared after dropping trailing separators, because `git worktree list`
/// prints the record as stored while `rev-parse --show-toplevel` prints the
/// resolved one, and on a linked worktree the two can differ by one slash —
/// which would silently unmark the Session's own row.
fn same_place(recorded: &str, root: &Path) -> bool {
    let recorded = recorded.trim_end_matches('/');
    let root = root.to_string_lossy();
    let root = root.trim_end_matches('/');
    !root.is_empty() && recorded == root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_path_branch_and_head_state() {
        let out = parse(
            b"worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/wt\nHEAD def456\nbranch refs/heads/feat/x\n\n",
            Path::new("/repo"),
        );

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "/repo");
        assert_eq!(out[0].branch.as_deref(), Some("main"));
        assert!(!out[0].detached && !out[0].bare);
        assert_eq!(out[1].path, "/repo/wt");
        assert_eq!(out[1].branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn marks_the_sessions_own_worktree_and_only_it() {
        let out = parse(
            b"worktree /repo\nbranch refs/heads/main\n\nworktree /repo/wt\nbranch refs/heads/x\n\n",
            Path::new("/repo/wt"),
        );
        assert!(!out[0].current);
        assert!(out[1].current);
    }

    #[test]
    fn the_current_marker_survives_a_trailing_separator() {
        // `git worktree list` prints one, `rev-parse --show-toplevel` does not.
        let out = parse(
            b"worktree /repo/\nbranch refs/heads/main\n\n",
            Path::new("/repo"),
        );
        assert!(out[0].current);
    }

    #[test]
    fn detached_and_bare_are_their_own_lines() {
        // Neither carries a `branch` line, so a parser that required one would
        // drop the entry entirely.
        let out = parse(
            b"worktree /repo\nHEAD abc\nbare\n\nworktree /repo/wt\nHEAD def\ndetached\n\n",
            Path::new("/elsewhere"),
        );
        assert_eq!(out.len(), 2);
        assert!(out[0].bare);
        assert_eq!(out[0].branch, None);
        assert!(out[1].detached);
        assert_eq!(out[1].branch, None);
    }

    #[test]
    fn a_locked_worktree_carries_its_reason() {
        let out = parse(
            b"worktree /repo/wt\nHEAD abc\nbranch refs/heads/x\nlocked on a removable drive\n\n",
            Path::new("/repo"),
        );
        assert_eq!(out[0].locked.as_deref(), Some("on a removable drive"));
    }

    #[test]
    fn a_lock_with_no_reason_is_locked_not_unlocked() {
        // `locked` on its own means locked and says nothing more. Reading it as
        // "no lock" would report a protected worktree as prunable.
        let out = parse(b"worktree /w\nHEAD abc\nlocked\n\n", Path::new("/repo"));
        assert_eq!(out[0].locked.as_deref(), Some(""));
    }

    #[test]
    fn a_prunable_entry_is_reported_as_one() {
        let out = parse(
            b"worktree /gone\nHEAD abc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n\n",
            Path::new("/repo"),
        );
        assert!(out[0].prunable.is_some());
    }

    #[test]
    fn unknown_attributes_are_skipped_not_fatal() {
        let out = parse(
            b"worktree /repo\nHEAD abc\nfuture-attribute whatever\nbranch refs/heads/main\n\n",
            Path::new("/repo"),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn attributes_before_any_entry_are_ignored() {
        // Nothing to attach them to; a row with no path is not a worktree.
        let out = parse(b"HEAD abc\nbranch refs/heads/main\n\n", Path::new("/repo"));
        assert!(out.is_empty());
    }

    #[test]
    fn a_worktree_serialises_in_the_spelling_the_client_reads() {
        let wt = Worktree {
            path: "/repo".to_string(),
            branch: Some("main".to_string()),
            current: false,
            detached: false,
            bare: false,
            locked: None,
            prunable: Some("gone".to_string()),
        };
        let json = serde_json::to_value(&wt).unwrap();
        assert_eq!(json["path"], "/repo");
        assert!(json.get("locked").is_none());
        assert_eq!(json["prunable"], "gone");
    }
}
